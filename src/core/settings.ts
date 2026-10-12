import { PROVIDER_PRESETS, type ProviderKind } from "./embeddings";
import { normalizeDatabaseFolder } from "./db-paths";

export interface DatanotesSettings {
  /** Journal entries older than this many days are dropped (undo is no longer possible for them). */
  journalRetentionDays: number;
  /** Write log records to `logs/<day>.<source>.jsonl` in the engine's store. */
  fileLogEnabled: boolean;
  /** Log files older than this many days are deleted. */
  logRetentionDays: number;
  /**
   * Internal: Folder of the metastore (`<databaseFolder>/metastore.yaml`); new rows go to
   * `<databaseFolder>/<catalog>/<schema>/<table>/`. Not a key of the settings file: the engine finds
   * the folder at start (the folder of the vault's one `metastore.yaml`), and
   * `configure_database` moves it.
   */
  databaseFolder: string;
  /**
   * Internal: The database's id (`id` in `metastore.yaml`), set by the host at start: written into
   * the metastore when the engine creates it. Empty: none (a host without a store of its own).
   */
  databaseId: string;
  /** Row property naming the catalog table a note belongs to (`table: personal.metrics.mood`). */
  tableKey: string;
  /** Send the engine's logs to an OpenTelemetry collector or OTLP backend (OTLP/HTTP). */
  telemetryEnabled: boolean;
  /** OTLP/HTTP base URL; logs are POSTed to `<endpoint>/v1/logs`. */
  telemetryEndpoint: string;
  /** `service.name` resource attribute. */
  telemetryServiceName: string;
  /**
   * HTTP headers sent with every export: the API key or `Authorization` the backend asks for.
   * Kept in the settings file; `OTEL_EXPORTER_OTLP_HEADERS` adds to them.
   */
  telemetryHeaders: Record<string, string>;
  /** OTLP encoding: `http/protobuf` (the OpenTelemetry default) or `http/json`. */
  telemetryProtocol: "http/protobuf" | "http/json";
  /**
   * After a row is edited by hand, recompute its generated / identity columns (a few seconds
   * after the last change, as a journaled `recompute_columns` operation).
   */
  autoRecompute: boolean;
  /**
   * Rewrite the links to a note renamed or moved by hand (in a file manager, with git or a sync
   * tool), across the vault, once the vault has been quiet for 4 s and not while git pulls,
   * rebases or merges. The repair is one journaled `repair_links` operation that undo takes back.
   * Links an editor already rewrote stay as they are.
   */
  repairLinksOnHandMove: boolean;
  /** Semantic search: embed notes with `semanticProvider` (off by default: content is sent to it). */
  semanticEnabled: boolean;
  /** Embedding provider: `ollama`, `lmstudio`, `openrouter`, `openai` or `custom` (any OpenAI-compatible API). */
  semanticProvider: ProviderKind;
  /** Empty: the provider's default URL. */
  semanticBaseUrl: string;
  /** Embedding model, e.g. `nomic-embed-text` (Ollama) or `openai/text-embedding-3-small` (OpenRouter). */
  semanticModel: string;
  /** "vault": every note; "tables": only table rows. */
  semanticScope: "vault" | "tables";
  /** Folders left out of the index. */
  semanticExclude: string[];
  /** Passages per embedding request. */
  semanticBatchSize: number;
  /**
   * Port of the HTTP API (on 127.0.0.1 unless the service is told otherwise): 1024 to 65535, or 0
   * for any free port. Any other value stops the engine from starting.
   */
  httpServerPort: number;
  /** The owner's bearer token (generated at the first start). */
  httpServerToken: string;
  /**
   * Back up the engine's store to a git repository: commits as `storeBackupIntervalSeconds` says, each pushed
   * to `storeBackupRemote` (headless engine; `datanotes store backup` sets it).
   */
  storeBackupEnabled: boolean;
  /**
   * The git remote the store backup pushes to, such as a private GitHub repository. Empty: commits
   * in the store only, nothing pushed.
   */
  storeBackupRemote: string;
  /**
   * How often the store backup looks for changes, in seconds (at least 10): when something changed,
   * it commits between two operations (a consistent snapshot), then pushes.
   */
  storeBackupIntervalSeconds: number;
}

export const DEFAULT_SETTINGS: DatanotesSettings = {
  journalRetentionDays: 90,
  fileLogEnabled: true,
  logRetentionDays: 30,
  databaseFolder: "datanotes",
  databaseId: "",
  tableKey: "table",
  telemetryEnabled: false,
  telemetryEndpoint: "http://127.0.0.1:4318",
  telemetryServiceName: "datanotes",
  telemetryHeaders: {},
  telemetryProtocol: "http/protobuf",
  autoRecompute: true,
  repairLinksOnHandMove: true,
  semanticEnabled: false,
  semanticProvider: "ollama",
  semanticBaseUrl: "",
  semanticModel: "",
  semanticScope: "vault",
  semanticExclude: [],
  semanticBatchSize: 32,
  httpServerPort: 27150,
  httpServerToken: "",
  storeBackupEnabled: false,
  storeBackupRemote: "",
  storeBackupIntervalSeconds: 60,
};

/** Keys only the host sets at start: never read from nor written to the settings file. */
export const RUNTIME_KEYS = ["databaseFolder", "databaseId"] as const;


const KEYS: (keyof DatanotesSettings)[] = [
  "journalRetentionDays",
  "fileLogEnabled",
  "logRetentionDays",
  "databaseFolder",
  "databaseId",
  "tableKey",
  "telemetryEnabled",
  "telemetryEndpoint",
  "telemetryServiceName",
  "telemetryHeaders",
  "telemetryProtocol",
  "autoRecompute",
  "repairLinksOnHandMove",
  "semanticEnabled",
  "semanticProvider",
  "semanticBaseUrl",
  "semanticModel",
  "semanticScope",
  "semanticExclude",
  "semanticBatchSize",
  "httpServerPort",
  "httpServerToken",
  "storeBackupEnabled",
  "storeBackupRemote",
  "storeBackupIntervalSeconds",
];

/**
 * Merges persisted data with defaults. Keys not in {@link DatanotesSettings}
 * are ignored (forward compatibility: old saves with extra fields do not break).
 * Invalid or mistyped values for a known key fall back to the default for that key, except
 * `httpServerPort`: an invalid port throws (falling back would take the usual engine's port).
 */

export function mergeWithDefaults(
  loaded: Partial<DatanotesSettings> & Record<string, unknown>,
): DatanotesSettings {
  const out: DatanotesSettings = { ...DEFAULT_SETTINGS };

  for (const key of KEYS) {
    if (!(key in loaded)) continue;
    const raw = loaded[key];
    if (raw === undefined) continue;

    switch (key) {
      case "telemetryEndpoint": {
        if (typeof raw === "string" && /^https?:\/\/\S+$/.test(raw.trim())) {
          out.telemetryEndpoint = raw.trim().replace(/\/+$/, "");
        }
        break;
      }
      case "telemetryProtocol": {
        if (raw === "http/protobuf" || raw === "http/json") out.telemetryProtocol = raw;
        break;
      }
      case "telemetryHeaders": {
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          out.telemetryHeaders = Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).filter(([k, v]) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k) && typeof v === "string"),
          ) as Record<string, string>;
        }
        break;
      }
      case "telemetryServiceName": {
        if (typeof raw === "string" && raw.trim().length > 0) {
          out.telemetryServiceName = raw.trim();
        }
        break;
      }
      case "tableKey": {
        if (typeof raw === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(raw.trim())) out.tableKey = raw.trim();
        break;
      }
      case "databaseFolder": {
        // "" is the root of the vault: the database is the folder the engine serves (--database)
        if (typeof raw === "string") out.databaseFolder = normalizeDatabaseFolder(raw);
        break;
      }
      case "databaseId": {
        if (typeof raw === "string") out.databaseId = raw.trim();
        break;
      }
      case "journalRetentionDays":
      case "logRetentionDays": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) out[key] = raw;
        break;
      }
      case "semanticProvider": {
        if (typeof raw === "string" && raw in PROVIDER_PRESETS) out.semanticProvider = raw as ProviderKind;
        break;
      }
      case "semanticBaseUrl": {
        if (typeof raw === "string" && (raw.trim() === "" || /^https?:\/\/\S+$/.test(raw.trim()))) out.semanticBaseUrl = raw.trim().replace(/\/+$/, "");
        break;
      }
      case "semanticModel": {
        if (typeof raw === "string") out.semanticModel = raw.trim();
        break;
      }
      case "semanticScope": {
        if (raw === "vault" || raw === "tables") out.semanticScope = raw;
        break;
      }
      case "semanticExclude": {
        if (Array.isArray(raw)) out.semanticExclude = raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().replace(/^\/+|\/+$/g, ""));
        break;
      }
      case "semanticBatchSize": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 512) out.semanticBatchSize = raw;
        break;
      }
      case "httpServerPort": {
        // Refused, not replaced by the default: the default is the port of the usual engine, which
        // another engine must never take by mistake. 0 is any free port.
        if (typeof raw !== "number" || !Number.isInteger(raw) || (raw !== 0 && (raw < 1024 || raw > 65535))) {
          throw new Error(`invalid setting httpServerPort: ${JSON.stringify(raw)} (an integer from 1024 to 65535, or 0 for any free port)`);
        }
        out.httpServerPort = raw;
        break;
      }
      case "httpServerToken": {
        if (typeof raw === "string") out.httpServerToken = raw.trim();
        break;
      }
      case "storeBackupRemote": {
        if (typeof raw === "string") out.storeBackupRemote = raw.trim();
        break;
      }
      case "storeBackupIntervalSeconds": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 10) out.storeBackupIntervalSeconds = raw;
        break;
      }
      case "storeBackupEnabled":
      case "telemetryEnabled":
      case "fileLogEnabled":
      case "semanticEnabled":
      case "autoRecompute":
      case "repairLinksOnHandMove": {
        if (typeof raw === "boolean") {
          out[key] = raw;
        }
        break;
      }
    }
  }

  return out;
}
