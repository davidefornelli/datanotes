/**
 * The read cache of the HTTP API (`rest.ts`): the answer of a read asked again with the same
 * arguments, by the same token, comes from memory while nothing it depends on has changed.
 *
 * An answer is kept under a key made of the operation, its arguments (keys sorted), the token
 * behind the call and its permissions, the settings, the metastore it was computed on, and the
 * versions of what it read:
 *
 * - a plain `select_rows` or `describe_table` reads the rows of known tables (a view: the tables
 *   its query reads, views over views included): the version of each of those tables;
 * - `list_tables` reads the metastore only; `describe_database` the rows of every table, and the
 *   notes without properties (rows that cannot be read): their versions;
 * - `read_note` reads one note: its version; `list_folder` one folder's children: the version
 *   of that folder (a note or folder created, deleted or renamed in it); both also move when any
 *   folder is deleted or renamed (the host tells nothing of the folders inside it);
 * - the graph operations read the rows of every table and the links between notes: those tables'
 *   versions and the version of the links; a `select_rows` that reads `file_backlink_count`
 *   reads its tables and the links (under a token's read scope, every table: only the notes of
 *   the tables it may read count);
 * - a dotted key in a filter (`{"project.status": …}`): the tables its link columns lead to; one
 *   that cannot be followed from the metastore: the whole vault;
 * - every other cached read (links followed, `within`, a search, a base) may read any note: the
 *   version of the whole vault.
 *
 * The versions move with the host's events, before the engine reads anything of the change. A
 * table's version is the vault index's generation of its rows (vault-index.ts): it moves when one
 * of its rows changes, comes or goes. A note created, changed, renamed or deleted moves the
 * vault's version; `metastore.yaml` moves every version, a finished link resolution the vault's.
 * The links' version moves when a file comes or goes (a link may resolve elsewhere), and when the
 * links a note resolves to change (compared once the host has resolved them). Hand edits reach the index before a request runs
 * (vault-settle.ts), so they count too. A write moves them while it runs: an answer computed while
 * a version moved is not kept. A read whose filters say `{now…}` is not kept; one that says
 * `{today…}` is kept for the current quarter hour only.
 *
 * Not cached: reads of the store (history, migrations, the change feed, webhooks),
 * `system.information_schema` (its `latest_version` comes from the transaction log), the semantic
 * index, `check_table` (CHECKs may compare with today), time travel, and any host without vault
 * events (the answer could not be told stale).
 *
 * Answers are kept as JSON text, so a hit is not serialized again; the memory is bounded by
 * `readCacheMaxBytes` (the JSON's length, least recently used first out).
 */

import type { App, EventRef, TAbstractFile, TFile } from "../core/host";
import { cachedMetastore, catalogTables, loadMetastore, metastorePath, rowTableFull, type Metastore } from "../core/metastore";
import { queryTables, refOf } from "../core/query-tables";
import type { DatanotesSettings } from "../core/settings";
import { contentHash } from "../core/file-cache";
import { currentReadScope } from "../core/read-scope";
import { vaultIndex } from "../core/vault-index";

/** Reads whose answers are kept: their answer depends on the vault and the metastore only. */
export const CACHED_READS: ReadonlySet<string> = new Set([
  "select_rows",
  "describe_table",
  "list_tables",
  "describe_database",
  "graph_neighbors",
  "graph_traverse",
  "graph_path",
  "list_link_targets",
  "read_note",
  "list_folder",
  "search_notes",
  "infer_table",
]);

/** The graph operations: their answers name notes, tables and edge labels, nothing else of a note. */
const GRAPH_READS: ReadonlySet<string> = new Set(["graph_neighbors", "graph_traverse", "graph_path"]);

/** Settings that never change an answer and must not sit in memory as part of a key. */
const SECRET_SETTINGS = new Set(["httpServerToken", "telemetryHeaders", "storeBackupRemote"]);

/** A quarter of an hour: every time zone's midnight falls on one. */
const TODAY_BUCKET_MS = 15 * 60_000;

/** A cached answer: its JSON text and what its operation span says of it. */
export interface CachedAnswer {
  status: number;
  body: string;
  returnedRows?: number;
  total?: number;
}

/** What a read depends on: tables by full name, or the whole vault; `today` when it reads the date. */
interface Deps {
  tables: string[] | "vault";
  today: boolean;
  /** The links between notes (the graph, backlinks). */
  links?: boolean;
  /** Notes read by path (`read_note`). */
  paths?: string[];
  /** Folders whose children are listed (`list_folder`). */
  folders?: string[];
  /** The notes the index has no properties for (rows that cannot be read: `describe_database`). */
  loose?: boolean;
}

/** A vault path as the versions key it: slashes as written, no case (hosts that ignore it), one Unicode form. */
function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").normalize("NFC").toLowerCase();
}

/** The folder of a vault path ("" for the root). */
function parentKey(key: string): string {
  const i = key.lastIndexOf("/");
  return i < 0 ? "" : key.slice(0, i);
}

/** At most this many paths and folders have a version of their own: past it, every key moves and they start again. */
export const PATH_VERSIONS = { max: 100_000 };

/** A read's key, to look it up and to keep its answer. */
export interface CacheTicket {
  key: string;
  /** The versions the answer is computed on (the key's part that moves). */
  versions: string;
  deps: Deps;
}

export interface ReadCacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
}

/** Sorted-key JSON: the same arguments in another order are the same read. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export class ReadCache {
  private readonly entries = new Map<string, { answer: CachedAnswer; bytes: number }>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  /** Moves every key: the metastore, link resolution, an unknown `table` value. */
  private global = 0;
  /** Moves with any change of the vault. */
  private vault = 0;
  /** Moves when a write starts or ends. */
  private writes = 0;
  private readonly tables = new Map<string, number>();
  /** Notes and folders by {@link pathKey}: moved by any change of the note, by a child created, deleted or renamed. */
  private readonly paths = new Map<string, number>();
  private readonly folders = new Map<string, number>();
  /** Moves when a note the index has (or had) no properties for changes, or goes. */
  private loose = 0;
  /** The notes the index has no properties for (rows that cannot be read among them), as last seen. */
  private readonly loosePaths = new Set<string>();
  /** Whether {@link loosePaths} was read (on the first read). */
  private looseKnown = false;
  /** Moves when the links between notes may have changed. */
  private links = 0;
  /**
   * Moves when a folder is deleted or renamed: every folder and note under it went too, and the
   * host tells no event for a folder inside it (an empty one).
   */
  private tree = 0;
  /**
   * Each note's resolved links, as a hash, once a read depends on the links (null before): an
   * edit that leaves them as they were does not move {@link links}.
   */
  private linkPrints: Map<string, string> | null = null;
  /** Notes changed since the host last resolved the links: compared again once it has. */
  private readonly unresolvedEdits = new Set<string>();
  private readonly refs: { target: { offref?(ref: EventRef): void }; ref: EventRef }[] = [];
  private readonly modelIds = new WeakMap<Metastore, number>();
  private nextModelId = 1;
  private readonly settingsIds = new Map<string, number>();
  private nextSettingsId = 1;
  /** The host has vault events: without them a change could not be seen, and nothing is cached. */
  readonly watching: boolean;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => DatanotesSettings,
    private readonly now: () => number = Date.now,
  ) {
    const v = app.vault as Partial<App["vault"]>;
    const mc = app.metadataCache as Partial<App["metadataCache"]> | undefined;
    this.watching = typeof v.on === "function" && typeof mc?.on === "function";
    if (!this.watching) return;
    const listen = (target: { offref?(ref: EventRef): void }, ref: EventRef) => this.refs.push({ target, ref });
    listen(app.vault, app.vault.on("create", (f: TAbstractFile) => this.touch(f.path, true)));
    listen(
      app.vault,
      app.vault.on("delete", (f: TAbstractFile) => {
        if ("children" in f) this.tree++;
        this.touch(f.path, true);
      }),
    );
    listen(app.vault, app.vault.on("modify", (f: TAbstractFile) => this.touch(f.path)));
    listen(
      app.vault,
      app.vault.on("rename", (f: TAbstractFile, old: string) => {
        if ("children" in f) this.tree++;
        this.touch(old, true);
        this.touch(f.path, true);
      }),
    );
    listen(app.metadataCache, app.metadataCache.on("changed", (f: TFile) => this.touch(f.path)));
    // links resolved again: a link may now reach another note (reads that follow links read the vault)
    listen(
      app.metadataCache,
      app.metadataCache.on("resolved", () => {
        this.vault++;
        for (const p of this.unresolvedEdits) this.compareLinks(p);
        this.unresolvedEdits.clear();
      }),
    );
  }

  /** Stop following the vault and forget every answer. */
  dispose(): void {
    for (const { target, ref } of this.refs.splice(0)) target.offref?.(ref);
    this.clear();
  }

  get maxBytes(): number {
    return this.watching ? Math.max(0, this.getSettings().readCacheMaxBytes) : 0;
  }

  stats(): ReadCacheStats {
    return { entries: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses };
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /** A write starts or ends: whatever it changes outside the notes, nothing computed before it is reused. */
  writeBoundary(): void {
    this.writes++;
  }

  /**
   * The key of a read, or null when its answer is not kept (an operation not cached, the cache
   * off, a filter on the current time). `scope` names the token and its permissions.
   */
  async ticket(op: string, body: Record<string, unknown>, scope: string): Promise<CacheTicket | null> {
    if (this.maxBytes === 0 || !CACHED_READS.has(op)) return null;
    const settings = this.getSettings();
    // the metastore the operation will read (it is read again when its file changed on disk)
    const model = (await loadMetastore(this.app, settings).catch(() => null))?.model ?? null;
    const deps = readDeps(op, body, model, currentReadScope() !== null);
    if (!deps) return null;
    if (!this.looseKnown) this.indexLoose(settings);
    if (deps.links && !this.linkPrints) this.printLinks();
    const versions = this.versionsOf(deps, model);
    const fixed = [op, scope, this.settingsId(settings), canonicalJson(body)].join("\u0000");
    return { key: `${fixed}\u0000${versions}`, versions, deps };
  }

  /** The answer kept for this read, if any (a miss is counted when its answer is computed: {@link set}). */
  get(t: CacheTicket): CachedAnswer | undefined {
    const e = this.entries.get(t.key);
    if (!e) return undefined;
    // least recently used last out
    this.entries.delete(t.key);
    this.entries.set(t.key, e);
    this.hits++;
    return e.answer;
  }

  /**
   * Keep an answer computed for `t`, unless something it read changed meanwhile (a write ran
   * along) or it is too large. Returns whether it was kept.
   */
  set(t: CacheTicket, answer: CachedAnswer): boolean {
    this.misses++;
    const max = this.maxBytes;
    const bytes = answer.body.length + t.key.length;
    if (max === 0 || bytes > max / 4) return false;
    const model = cachedMetastore(this.app, this.getSettings());
    if (this.versionsOf(t.deps, model) !== t.versions) return false;
    const old = this.entries.get(t.key);
    if (old) {
      this.entries.delete(t.key);
      this.bytes -= old.bytes;
    }
    this.entries.set(t.key, { answer, bytes });
    this.bytes += bytes;
    for (const [k, e] of this.entries) {
      if (this.bytes <= max) break;
      this.entries.delete(k);
      this.bytes -= e.bytes;
    }
    return true;
  }

  private versionsOf(deps: Deps, model: Metastore | null): string {
    const head = `m${model ? this.modelId(model) : 0}g${this.global}${deps.today ? `d${Math.floor(this.now() / TODAY_BUCKET_MS)}` : ""}`;
    if (deps.tables === "vault") return `${head}v${this.vault}w${this.writes}`;
    // the generations of the tables' rows, from the vault index (brought up to date by the call)
    const idx = deps.tables.length > 0 ? vaultIndex(this.app, this.getSettings()) : null;
    // a host whose index throws for a note: every change counts
    if (idx?.hasFailures) return `${head}v${this.vault}w${this.writes}`;
    let out = `${head}t${deps.tables.map((t) => `${t}=${idx?.tableGeneration(t) ?? 0}`).join(",")}`;
    if (deps.links) out += `k${this.links}`;
    if (deps.paths) out += `p${deps.paths.map((p) => this.paths.get(pathKey(p)) ?? 0).join(",")}`;
    if (deps.folders) out += `f${deps.folders.map((f) => this.folders.get(pathKey(f)) ?? 0).join(",")}`;
    if (deps.paths || deps.folders) out += `r${this.tree}`;
    if (deps.loose) out += `l${this.loose}`;
    return out;
  }

  /** The settings by a short number (their JSON, secrets left out): keys stay short. */
  private settingsId(s: DatanotesSettings): number {
    const json = settingsKey(s);
    let id = this.settingsIds.get(json);
    if (id === undefined) {
      // settings change rarely: a handful of versions is all there is to remember
      if (this.settingsIds.size >= 64) this.settingsIds.clear();
      this.settingsIds.set(json, (id = this.nextSettingsId++));
    }
    return id;
  }

  private modelId(model: Metastore): number {
    let id = this.modelIds.get(model);
    if (id === undefined) this.modelIds.set(model, (id = this.nextModelId++));
    return id;
  }

  /**
   * A note (or any file) changed: the vault, the note, the tables it belonged to and belongs to
   * now; created, deleted or renamed (`moved`): its folder's children, and its own (a folder).
   */
  private touch(path: string, moved = false): void {
    this.vault++;
    const settings = this.getSettings();
    if (path === metastorePath(settings)) this.global++;
    const key = pathKey(path);
    this.bump(this.paths, key);
    if (moved) {
      this.bump(this.folders, parentKey(key));
      this.bump(this.folders, key);
      // a file came or went: links elsewhere may resolve to it, or no longer
      this.links++;
      this.linkPrints?.delete(path);
    } else if (this.linkPrints) {
      // its links as the host has resolved them now, and again once it announces a resolution
      this.compareLinks(path);
      this.unresolvedEdits.add(path);
    } else this.links++;
    if (!this.looseKnown) return; // nothing kept yet: the notes are read on the first read
    // a row that cannot be read, or that can be read again: either side counts
    const wasLoose = this.loosePaths.delete(path);
    const isLoose = key.endsWith(".md") && !this.hasProperties(path);
    if (isLoose && this.app.vault.getAbstractFileByPath(path)) this.loosePaths.add(path);
    if (wasLoose || isLoose) this.loose++;
  }

  private bump(versions: Map<string, number>, key: string): void {
    if (versions.size >= PATH_VERSIONS.max && !versions.has(key)) {
      // the versions start again from 0: every key moves first, so no answer kept before is reused
      this.paths.clear();
      this.folders.clear();
      this.global++;
    }
    versions.set(key, (versions.get(key) ?? 0) + 1);
  }

  /** Whether the note is there and the index has its properties (a row that cannot be read has none). */
  private hasProperties(path: string): boolean {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !("extension" in f)) return false;
    try {
      return this.app.metadataCache.getFileCache(f as TFile)?.frontmatter != null;
    } catch {
      return false; // a host whose index throws on broken YAML
    }
  }

  /** A note's resolved links, as a hash ("" without any). */
  private linksPrint(path: string): string {
    const out = this.app.metadataCache.resolvedLinks[path];
    return out ? contentHash(JSON.stringify(out)) : "";
  }

  /** Every note's resolved links, the first time a read depends on them. */
  private printLinks(): void {
    this.linkPrints = new Map();
    for (const [p, out] of Object.entries(this.app.metadataCache.resolvedLinks)) this.linkPrints.set(p, contentHash(JSON.stringify(out)));
  }

  /** The links of `path` compared with those last seen: a change moves the links' version. */
  private compareLinks(path: string): void {
    if (!this.linkPrints) return;
    const now = this.linksPrint(path);
    if ((this.linkPrints.get(path) ?? "") === now) return;
    this.links++;
    if (now === "") this.linkPrints.delete(path);
    else this.linkPrints.set(path, now);
  }

  /** The notes without properties, from the vault index (a walk of the vault on a host without one). */
  private indexLoose(settings: DatanotesSettings): void {
    this.looseKnown = true;
    const idx = vaultIndex(this.app, settings);
    if (idx && !idx.hasFailures) {
      for (const n of idx.allNotes()) if (n.bare) this.loosePaths.add(n.path);
      return;
    }
    for (const f of this.app.vault.getMarkdownFiles()) if (!this.hasProperties(f.path)) this.loosePaths.add(f.path);
  }
}

/** The settings as part of a key (an answer depends on some of them), secrets left out. */
function settingsKey(s: DatanotesSettings): string {
  return JSON.stringify(s, (k, v: unknown) => (SECRET_SETTINGS.has(k) ? undefined : v));
}

/** What a read depends on, or null when its answer must not be kept. `restricted`: the caller has a read scope. */
export function readDeps(op: string, body: Record<string, unknown>, model: Metastore | null, restricted = false): Deps | null {
  if (!CACHED_READS.has(op)) return null;
  const text = JSON.stringify(body);
  if (text.includes("{now")) return null;
  const today = text.includes("{today");
  if (op === "select_rows") {
    if (body.version !== undefined || body.timestamp !== undefined) return null;
    if (!model) return { tables: "vault", today };
    const found = new Set<string>();
    const r = queryTables(body, model, found, 0);
    if (r.now || r.store) return null;
    if (!r.vault) {
      // under a read scope, backlinks count only the notes of readable tables: a linking note that
      // joins or leaves a table changes the count, so every table's rows count
      const tables = r.links && restricted ? catalogTables(model).map(({ ref }) => ref.full) : [...found];
      return { tables: tables.sort(), today: today || r.today, ...(r.links ? { links: true } : {}) };
    }
    // a read of the whole vault may run any view (`within` a view's rows): the time of every view counts
    const views = viewTimes(model);
    if (views.now) return null;
    return { tables: "vault", today: today || r.today || views.today };
  }
  if (op === "describe_table" && model && typeof body.table === "string") {
    const ref = refOf(model, body.table, "table");
    if (ref && !refOf(model, body.table, "view")) return { tables: [ref], today };
  }
  // the metastore only
  if (op === "list_tables") return { tables: [], today };
  // every table's rows (their counts) and the rows that cannot be read
  if (op === "describe_database" && model) return { tables: catalogTables(model).map(({ ref }) => ref.full), today, loose: true };
  if (op === "read_note" && typeof body.path === "string") return { tables: [], today, paths: [body.path] };
  if (op === "list_folder" && (body.folder === undefined || typeof body.folder === "string")) return { tables: [], today, folders: [body.folder ?? ""] };
  // the rows of every table (start sets, labels) and the links between notes; `within` follows links of rows
  if (GRAPH_READS.has(op) && model) return { tables: catalogTables(model).map(({ ref }) => ref.full).sort(), today, links: true };
  return { tables: "vault", today };
}

const VIEW_TIMES = new WeakMap<Metastore, { today: boolean; now: boolean }>();

/** Whether any view of the metastore reads the date or the time. */
function viewTimes(model: Metastore): { today: boolean; now: boolean } {
  let t = VIEW_TIMES.get(model);
  if (!t) {
    const text = JSON.stringify(Object.values(model.catalogs).flatMap((c) => Object.values(c.schemas).flatMap((s) => Object.values(s.views ?? {}).map((v) => v.query))));
    VIEW_TIMES.set(model, (t = { today: text.includes("{today"), now: text.includes("{now") }));
  }
  return t;
}
