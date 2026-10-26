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
  /** Send the engine's logs and traces to an OpenTelemetry collector or OTLP backend (OTLP/HTTP). */
  telemetryEnabled: boolean;
  /** OTLP/HTTP base URL; logs are POSTed to `<endpoint>/v1/logs`, traces to `<endpoint>/v1/traces`. */
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
   * Send traces too while telemetry is on: a span for every HTTP request, operation and phase of
   * an operation (lock, query, checks, journal, vault calls), with its duration and parent.
   * `OTEL_TRACES_EXPORTER=none` turns them off.
   */
  telemetryTraces: boolean;
  /**
   * Share of new traces kept, from 0 to 1 (1: every one). A trace continued from a caller
   * (`traceparent`) follows the caller's choice. `OTEL_TRACES_SAMPLER` overrides it.
   */
  telemetryTraceSampleRatio: number;
  /** Most spans one trace may hold (1 to 100000); the others are dropped and counted in `datanotes.spans_dropped`. */
  telemetryMaxSpansPerTrace: number;
  /** A request, operation or background job lasting at least this many milliseconds is also logged as a WARN (0: never). */
  telemetrySlowSpanMs: number;
  /** `deployment.environment.name` of the logs and traces, such as `dev` or `home` (empty: none). */
  telemetryEnvironment: string;
  /**
   * After a row is edited by hand, recompute its generated / identity columns (a few seconds
   * after the last change, as a journaled `recompute_columns` operation).
   */
  autoRecompute: boolean;
  /**
   * Once a day, after 10 minutes without writes, put the rows of closed periods into packs
   * (`pack_rows` on every table with a `pack` option; the engine service only). Off: tables are
   * packed only by `pack_rows`.
   */
  autoPack: boolean;
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
   * Write priority: while a write runs or waits, new reads wait for it (reads under way finish),
   * so a stream of reads does not slow a write down. Writes start one at a time, in order.
   */
  writePriority: boolean;
  /** The longest a read waits for writes under `writePriority`, in milliseconds (0 to 60000). */
  writePriorityMaxWaitMs: number;
  /**
   * Memory for the answers of repeated reads, in bytes (0: no cache). A read asked again with the
   * same arguments is answered from it while nothing it depends on has changed.
   */
  readCacheMaxBytes: number;
  /**
   * Keep an index of the vault's notes in the engine's store (`index/vault.sqlite`), so that a
   * start reads only the notes changed since the last one, and `search_notes` only the notes that
   * can match (headless engine, Node 22.13 or later). The index is a cache: deleting it is safe,
   * the next start builds it again. Off: every start and every search reads every note, and the
   * index is deleted.
   */
  vaultIndexEnabled: boolean;
  /**
   * Port of the HTTP API (on 127.0.0.1 unless the service is told otherwise): 1024 to 65535, or 0
   * for any free port. Any other value stops the engine from starting.
   */
  httpServerPort: number;
  /** The owner's bearer token (generated at the first start). */
  httpServerToken: string;
  /**
   * Which clients of the HTTP API get answers of 16 KB or more compressed with gzip, when their
   * request says `Accept-Encoding: gzip`: `remote` (default) those on other machines, `always`
   * this machine's too, `off` none. Compressing costs the engine time that a client on the same
   * machine does not win back.
   */
  httpCompression: "remote" | "always" | "off";
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
  /**
   * How the engine makes its store files durable: `operation` syncs (fsync) every store file an
   * operation wrote once, when the operation ends (the journal line, the transaction log, the
   * blobs; the change feed after each of its appends); `off` leaves it to the operating system,
   * which is faster but lets a power loss take the last operations' undo data and history. Notes
   * are never synced (they are written atomically, as Obsidian writes them). Headless engine.
   */
  storeSync: "operation" | "off";
  /**
   * How the transaction log writes new versions: `segments` (default since 3.1) appends them to a
   * few large files (far fewer files for the antivirus, git and the store backup), which
   * Datanotes 3.0 cannot read: run `datanotes store convert-log --to files` before you go back
   * to it; `files` writes one file per version, which every Datanotes 3 reads. The engine reads
   * both, also mixed in one folder: a log of 3.0 keeps its files and grows in segments.
   */
  transactionLogFormat: "files" | "segments";
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
  telemetryTraces: true,
  telemetryTraceSampleRatio: 1,
  telemetryMaxSpansPerTrace: 1000,
  telemetrySlowSpanMs: 0,
  telemetryEnvironment: "",
  autoRecompute: true,
  autoPack: true,
  repairLinksOnHandMove: true,
  semanticEnabled: false,
  semanticProvider: "ollama",
  semanticBaseUrl: "",
  semanticModel: "",
  semanticScope: "vault",
  semanticExclude: [],
  semanticBatchSize: 32,
  writePriority: true,
  writePriorityMaxWaitMs: 100,
  readCacheMaxBytes: 33554432,
  vaultIndexEnabled: true,
  httpServerPort: 27150,
  httpServerToken: "",
  httpCompression: "remote",
  storeBackupEnabled: false,
  storeBackupRemote: "",
  storeBackupIntervalSeconds: 60,
  storeSync: "operation",
  transactionLogFormat: "segments",
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
  "telemetryTraces",
  "telemetryTraceSampleRatio",
  "telemetryMaxSpansPerTrace",
  "telemetrySlowSpanMs",
  "telemetryEnvironment",
  "autoRecompute",
  "autoPack",
  "repairLinksOnHandMove",
  "semanticEnabled",
  "semanticProvider",
  "semanticBaseUrl",
  "semanticModel",
  "semanticScope",
  "semanticExclude",
  "semanticBatchSize",
  "writePriority",
  "writePriorityMaxWaitMs",
  "readCacheMaxBytes",
  "vaultIndexEnabled",
  "httpServerPort",
  "httpServerToken",
  "httpCompression",
  "storeBackupEnabled",
  "storeBackupRemote",
  "storeBackupIntervalSeconds",
  "storeSync",
  "transactionLogFormat",
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
      case "telemetryTraceSampleRatio": {
        if (typeof raw === "number" && raw >= 0 && raw <= 1) out.telemetryTraceSampleRatio = raw;
        break;
      }
      case "telemetryMaxSpansPerTrace": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 100000) out.telemetryMaxSpansPerTrace = raw;
        break;
      }
      case "telemetrySlowSpanMs": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) out.telemetrySlowSpanMs = raw;
        break;
      }
      case "telemetryEnvironment": {
        if (typeof raw === "string") out.telemetryEnvironment = raw.trim();
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
      case "writePriorityMaxWaitMs": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 60000) out.writePriorityMaxWaitMs = raw;
        break;
      }
      case "readCacheMaxBytes": {
        if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) out.readCacheMaxBytes = raw;
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
      case "httpCompression": {
        if (raw === "remote" || raw === "always" || raw === "off") out.httpCompression = raw;
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
      case "storeSync": {
        if (raw === "operation" || raw === "off") out.storeSync = raw;
        break;
      }
      case "transactionLogFormat": {
        if (raw === "files" || raw === "segments") out.transactionLogFormat = raw;
        break;
      }
      case "storeBackupEnabled":
      case "telemetryEnabled":
      case "telemetryTraces":
      case "fileLogEnabled":
      case "semanticEnabled":
      case "autoRecompute":
      case "autoPack":
      case "writePriority":
      case "vaultIndexEnabled":
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
