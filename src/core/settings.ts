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

/** A key of the settings file: every setting but the ones the host sets at start. */
export type EditableSettingKey = Exclude<keyof DatanotesSettings, (typeof RUNTIME_KEYS)[number]>;
export type SettingType = "boolean" | "integer" | "number" | "string" | "enum" | "string_list" | "string_map";

/** How a setting is read from the settings file and changed while the engine runs. */
export interface SettingRule {
  type: SettingType;
  /** The allowed values in words, read after "<name> takes " (errors, the browser, the reference). */
  expected: string;
  values?: readonly string[];
  minimum?: number;
  maximum?: number;
  /** What the loader keeps for `raw` (the settings file's rule); undefined: it does not keep it. */
  load(raw: unknown): unknown;
  /** When a change reaches a running engine: at once, or at the next start. */
  applies: "live" | "restart";
  /** Never changed over HTTP: why, and how instead. */
  fileOnly?: string;
  /** "value": never sent; "header_values": the map's values hidden; "url_credentials": user and password stripped. */
  secret?: "value" | "header_values" | "url_credentials";
  /** An address the engine sends data to. */
  sendsData?: true;
  /** Shown before a change is saved; a change of it is logged as WARN. */
  warning?: string;
  /** Shown after a change: what to do next. */
  followUp?: string;
  /** Writes over HTTP must also pass it (stricter than the loader). */
  writeCheck?: { test(value: unknown): boolean; expected: string };
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const bool = (raw: unknown): boolean | undefined => (typeof raw === "boolean" ? raw : undefined);
const oneOf = (values: readonly string[]): string => values.map((v) => JSON.stringify(v)).join(", ").replace(/, ([^,]*)$/, " or $1");
const isInt = (raw: unknown): raw is number => typeof raw === "number" && Number.isInteger(raw);
const enumOf = <T extends string>(values: readonly T[]) => (raw: unknown): T | undefined => (values as readonly unknown[]).includes(raw) ? (raw as T) : undefined;
const BOOLEAN = { type: "boolean", expected: "true or false", load: bool } as const;
const enumRule = (values: readonly string[]) => ({ type: "enum" as const, values, expected: oneOf(values), load: enumOf(values) });

const PROTOCOLS = ["http/protobuf", "http/json"] as const;
const PROVIDERS = Object.keys(PROVIDER_PRESETS);
const SCOPES = ["vault", "tables"] as const;
const COMPRESSIONS = ["remote", "always", "off"] as const;
const SYNCS = ["operation", "off"] as const;
const LOG_FORMATS = ["files", "segments"] as const;

/**
 * Every setting of the settings file: its type, what it takes, how the loader reads it
 * ({@link mergeWithDefaults}) and how a change over HTTP applies. One table for the loader, the
 * settings route and the settings reference.
 */
export const SETTING_RULES: Readonly<Record<EditableSettingKey, SettingRule>> = {
  journalRetentionDays: {
    type: "integer", minimum: 1, expected: "an integer of at least 1 (days)", applies: "live",
    load: (raw) => (isInt(raw) && raw >= 1 ? raw : undefined),
    warning: "Journal entries older than this are dropped at the next daily housekeeping, and their undo with them.",
  },
  fileLogEnabled: { ...BOOLEAN, applies: "live" },
  logRetentionDays: {
    type: "integer", minimum: 1, expected: "an integer of at least 1 (days)", applies: "live",
    load: (raw) => (isInt(raw) && raw >= 1 ? raw : undefined),
  },
  tableKey: {
    type: "string", expected: "a property name: a letter or _, then letters, digits, _ or -", applies: "restart",
    load: (raw) => (typeof raw === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(raw.trim()) ? raw.trim() : undefined),
    fileOnly: "Every row names its table with this property: changing it hides every row from the engine. Stop the engine, rename the property in every note, then change tableKey in the settings file.",
  },
  telemetryEnabled: {
    ...BOOLEAN, applies: "live",
    warning: "On, the engine sends its logs and traces (operation and table names, timings, errors) to telemetryEndpoint.",
  },
  telemetryEndpoint: {
    type: "string", expected: "an http or https URL, such as http://127.0.0.1:4318", applies: "live",
    load: (raw) => (typeof raw === "string" && /^https?:\/\/\S+$/.test(raw.trim()) ? raw.trim().replace(/\/+$/, "") : undefined),
    secret: "url_credentials", sendsData: true,
    warning: "While telemetry is on, the engine sends its logs and traces to this address.",
  },
  telemetryServiceName: {
    type: "string", expected: "a name that is not empty", applies: "live",
    load: (raw) => (typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined),
  },
  telemetryHeaders: {
    type: "string_map",
    expected: 'an object of HTTP header names and string values, such as {"Authorization": "Bearer <key>"}; a header set to null is removed',
    applies: "live",
    load: (raw) =>
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => HEADER_NAME.test(k) && typeof v === "string"))
        : undefined,
    secret: "header_values",
  },
  telemetryProtocol: { ...enumRule(PROTOCOLS), applies: "live" },
  telemetryTraces: { ...BOOLEAN, applies: "live" },
  telemetryTraceSampleRatio: {
    type: "number", minimum: 0, maximum: 1, expected: "a number from 0 to 1", applies: "live",
    load: (raw) => (typeof raw === "number" && raw >= 0 && raw <= 1 ? raw : undefined),
  },
  telemetryMaxSpansPerTrace: {
    type: "integer", minimum: 1, maximum: 100000, expected: "an integer from 1 to 100000", applies: "live",
    load: (raw) => (isInt(raw) && raw >= 1 && raw <= 100000 ? raw : undefined),
  },
  telemetrySlowSpanMs: {
    type: "integer", minimum: 0, expected: "an integer of at least 0 (milliseconds; 0: never)", applies: "live",
    load: (raw) => (isInt(raw) && raw >= 0 ? raw : undefined),
  },
  telemetryEnvironment: {
    type: "string", expected: 'a name, or "" for none', applies: "live",
    load: (raw) => (typeof raw === "string" ? raw.trim() : undefined),
  },
  autoRecompute: { ...BOOLEAN, applies: "live" },
  autoPack: { ...BOOLEAN, applies: "live" },
  repairLinksOnHandMove: { ...BOOLEAN, applies: "live" },
  semanticEnabled: {
    ...BOOLEAN, applies: "live",
    warning: "On, the engine sends the text of your notes to the embedding provider and indexes every note now: a paid provider charges for it.",
    followUp: "The engine indexes every note now: describe_semantic_index shows the progress.",
  },
  semanticProvider: {
    ...enumRule(PROVIDERS), applies: "live",
    followUp: "Passages embedded with the previous provider or model stay in the index: rebuild it (sync_semantic_index with rebuild: true).",
  },
  semanticBaseUrl: {
    type: "string", expected: 'an http or https URL, or "" for the provider\'s default', applies: "live",
    load: (raw) => (typeof raw === "string" && (raw.trim() === "" || /^https?:\/\/\S+$/.test(raw.trim())) ? raw.trim().replace(/\/+$/, "") : undefined),
    secret: "url_credentials", sendsData: true,
    warning: "While semantic search is on, the engine sends the text of your notes to this address.",
    followUp: "Passages embedded with the previous provider or model stay in the index: rebuild it (sync_semantic_index with rebuild: true).",
  },
  semanticModel: {
    type: "string", expected: 'a model name, such as nomic-embed-text, or "" for the provider\'s default', applies: "live",
    load: (raw) => (typeof raw === "string" ? raw.trim() : undefined),
    followUp: "Passages embedded with the previous provider or model stay in the index: rebuild it (sync_semantic_index with rebuild: true).",
  },
  semanticScope: { ...enumRule(SCOPES), applies: "live" },
  semanticExclude: {
    type: "string_list", expected: 'a list of folder paths, such as ["Archive", "Templates"]', applies: "live",
    load: (raw) =>
      Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().replace(/^\/+|\/+$/g, "")) : undefined,
  },
  semanticBatchSize: {
    type: "integer", minimum: 1, maximum: 512, expected: "an integer from 1 to 512", applies: "live",
    load: (raw) => (isInt(raw) && raw >= 1 && raw <= 512 ? raw : undefined),
  },
  writePriority: { ...BOOLEAN, applies: "live" },
  writePriorityMaxWaitMs: {
    type: "integer", minimum: 0, maximum: 60000, expected: "an integer from 0 to 60000 (milliseconds)", applies: "live",
    load: (raw) => (isInt(raw) && raw >= 0 && raw <= 60000 ? raw : undefined),
  },
  readCacheMaxBytes: {
    type: "integer", minimum: 0, expected: "an integer of at least 0 (bytes; 0: no cache)", applies: "live",
    load: (raw) => (isInt(raw) && raw >= 0 ? raw : undefined),
  },
  vaultIndexEnabled: {
    ...BOOLEAN, applies: "restart",
    warning: "Off, the next start deletes the vault index, and every start reads every note.",
  },
  httpServerPort: {
    type: "integer", minimum: 0, maximum: 65535, expected: "an integer from 1024 to 65535, or 0 for any free port", applies: "restart",
    // The loader throws for a bad port (mergeWithDefaults): never the usual engine's port by mistake.
    load: (raw) => (isInt(raw) && (raw === 0 || (raw >= 1024 && raw <= 65535)) ? raw : undefined),
    warning: "After the restart the engine, and this page, answer on this port. If another program holds it, the engine does not start. In a container, publish the new port too.",
  },
  httpServerToken: {
    type: "string", expected: "the owner's token", applies: "restart",
    load: (raw) => (typeof raw === "string" ? raw.trim() : undefined),
    secret: "value",
    warning: "After the restart only the new owner token opens the engine: this browser and every program that uses the owner token need it. Programs on this machine read it from the settings file.",
    writeCheck: {
      test: (value) => typeof value === "string" && /^[A-Za-z0-9._~-]{32,256}$/.test(value),
      expected: 'a token of 32 to 256 characters among A-Z, a-z, 0-9, ".", "_", "~" and "-" (the browser\'s Generate button makes one)',
    },
  },
  httpCompression: { ...enumRule(COMPRESSIONS), applies: "live" },
  storeBackupEnabled: {
    ...BOOLEAN, applies: "restart",
    warning: "On, after the restart the engine pushes its whole store (journal, history, change feed) to storeBackupRemote.",
  },
  storeBackupRemote: {
    type: "string", expected: 'a git remote, such as git@github.com:you/vault-store.git, or "" for commits in the store only', applies: "restart",
    load: (raw) => (typeof raw === "string" ? raw.trim() : undefined),
    secret: "url_credentials", sendsData: true,
    warning: "After the restart the engine pushes its whole store to this repository. datanotes store backup tests the push at once.",
  },
  storeBackupIntervalSeconds: {
    type: "integer", minimum: 10, expected: "an integer of at least 10 (seconds)", applies: "restart",
    load: (raw) => (isInt(raw) && raw >= 10 ? raw : undefined),
  },
  storeSync: {
    ...enumRule(SYNCS), applies: "live",
    warning: "Off, a power loss can take the undo data and history of the last operations.",
  },
  transactionLogFormat: {
    ...enumRule(LOG_FORMATS), applies: "restart",
    fileOnly: "Run datanotes store convert-log --to files (or segments) with the engine stopped: it converts the versions already written and sets this setting.",
  },
};

export type SettingCheck = { ok: true; value: unknown } | { ok: false; problem: string };

/**
 * Checks a value for a setting as a write over HTTP: what the loader keeps, and nothing it would
 * drop or replace. The problem never repeats the value of a secret.
 */
export function checkSetting(key: EditableSettingKey, raw: unknown): SettingCheck {
  const rule = SETTING_RULES[key];
  const v = rule.load(raw);
  if (v === undefined) {
    if (rule.secret) return { ok: false, problem: "the value is not allowed" };
    const text = String(JSON.stringify(raw));
    const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    return { ok: false, problem: `${shown} is not allowed` };
  }
  if (rule.type === "string_list") {
    const items = raw as unknown[];
    const bad = items.findIndex((x) => typeof x !== "string" || x.trim().replace(/^\/+|\/+$/g, "").trim() === "");
    if (bad >= 0) return { ok: false, problem: `item ${bad + 1} is not a folder path` };
  }
  if (rule.type === "string_map") {
    const entries = Object.entries(raw as Record<string, unknown>);
    const badName = entries.find(([k]) => !HEADER_NAME.test(k));
    if (badName) return { ok: false, problem: `${JSON.stringify(badName[0])} is not an HTTP header name` };
    const badValue = entries.find(([, val]) => typeof val !== "string");
    if (badValue) return { ok: false, problem: `the value of ${JSON.stringify(badValue[0])} must be a string` };
  }
  if (rule.writeCheck && !rule.writeCheck.test(v)) return { ok: false, problem: "the value is not allowed" };
  return { ok: true, value: v };
}

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
    // "" is the root of the vault: the database is the folder the engine serves (--database)
    if (key === "databaseFolder") {
      if (typeof raw === "string") out.databaseFolder = normalizeDatabaseFolder(raw);
      continue;
    }
    if (key === "databaseId") {
      if (typeof raw === "string") out.databaseId = raw.trim();
      continue;
    }
    const value = SETTING_RULES[key].load(raw);
    if (value === undefined) {
      // Refused, not replaced by the default: the default is the port of the usual engine, which
      // another engine must never take by mistake. 0 is any free port.
      if (key === "httpServerPort") throw new Error(`invalid setting httpServerPort: ${JSON.stringify(raw)} (an integer from 1024 to 65535, or 0 for any free port)`);
      continue;
    }
    (out as unknown as Record<string, unknown>)[key] = value;
  }

  return out;
}
