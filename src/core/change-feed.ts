/**
 * Change feed: every change to a table row, numbered, so services connected to the database learn
 * what changed instead of polling folders.
 *
 *   { seq, at, table, op: insert | update | delete | move | schema | unreadable, path, oldPath?, id?,
 *     changes?: { column: { before, after } }, source: engine | external, actor?, migration?, operation?,
 *     violations? }
 *
 * - writes made by the engine come from its apply hook (`onApplied`): agent and journal id known;
 * - hand edits (an editor, git, a sync tool) come from vault events (renames included), compared
 *   with the last known state of the row (`source: "external"`), a batch at a time, in the order
 *   they happened; the rows they create, change, rename or remove are checked against the tables'
 *   rules (as check_table does), with the rows linking to them, and the event carries what the
 *   edit breaks (`violations`, empty when nothing; absent when it was not checked);
 * - a hand edit that leaves a row's front matter unreadable (broken YAML) is an `unreadable` event
 *   with one `unreadable` violation: the row's last readable state is kept, and its fix is compared
 *   with it (an `update`, or an `insert` for a note the feed did not know as a row);
 * - `metastore.yaml` changes are `schema` events; a hand edit that changes tables' entries checks
 *   every row of those tables (`violations` on the schema event);
 * - notes a batch of hand edits renamed or moved (rows and plain notes) have the links to their old
 *   paths repaired before the batch is checked (hand-moves.ts, setting `repairLinksOnHandMove`):
 *   the repair's events come after the batch's, with the moves they follow (`cause`).
 *
 * Events are appended to `store:changes/<YYYY-MM-DD>.jsonl` (kept `retentionDays`) and the
 * latest ones stay in memory. `read` filters them; `wait` long-polls until a matching one arrives.
 */

import type { Actor } from "./actor";
import { engineWriting, loadTable, onApplied, type AppliedOperation, type LoadedRow } from "./engine";
import { checkChangedTables, checkExternalEdits, compileWhere, rowGetter, type ExternalEdit, type ExternalViolation, type Where } from "./rows";
import type { App, EventRef, TAbstractFile, TFile } from "./host";
import { readHashed } from "./file-cache";
import { frontmatterError, unreadableMessage, unreadableRowOf } from "./unreadable";
import { readRowFrontmatter } from "./inverse";
import { cachedMetastore, catalogTables, entryToOrdered, loadMetastore, METASTORE_FILE, metastorePath, parseMetastore, rowTableFull, type Metastore } from "./metastore";
import { movePath } from "./database-move";
import { externalRename, HandMoveRepairs, rowMovesSince, saveRowPaths, type HandMove } from "./hand-moves";
import { catalogLayout, parseTableOptions } from "./table-loader";
import { TABLE_KEY } from "./types-table";
import type { DatanotesSettings } from "./settings";
import { storeAppend, storeList, storePath, storeRead, storeRemove } from "./store";
import { telemetry } from "./telemetry";
import { messageOf } from "./message";
import { inDatabase, normalizeDatabaseFolder } from "./db-paths";

/** `unreadable`: a hand edit left a row's front matter unreadable (its last readable state is kept). */
export type ChangeOp = "insert" | "update" | "delete" | "move" | "schema" | "tool_call" | "unreadable";

/** An MCP tool call (event `op: "tool_call"`), delivered only to consumers that ask for that op. */
export interface ToolCallInfo {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  /** The result, or the error text (long values cut). */
  value: unknown;
  /** The result's top-level scalars, and lists as their length (e.g. `{total: 12, rows: 12, ok: true}`). */
  summary?: Record<string, unknown>;
  /** Who served the call: "engine", or the MCP server that ran a tool of its own. */
  servedBy: string;
  /** Size of what the agent got back: characters and estimated tokens. */
  resultChars?: number;
  resultTokens?: number;
  session?: string;
}

export interface ChangeEvent {
  seq: number;
  at: string;
  table: string | null;
  op: ChangeOp;
  path: string;
  oldPath?: string;
  id?: string;
  /** Changed columns with their values before and after (update), or every value (insert / delete). */
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  source: "engine" | "external";
  /** The row's values after the change (before it, for a delete): what `where` filters test. */
  row?: Record<string, unknown>;
  actor?: Actor;
  migration?: string;
  /** Engine operation (insert_row, update_rows, undo, …). */
  operation?: string;
  /** The call, for `op: "tool_call"`. */
  call?: ToolCallInfo;
  /**
   * External insert / update / move / delete (the last event of each row in a batch of hand
   * edits): the rules the edit breaks, the row's own and those of the rows linking to it (each
   * names its row's `path`); a rule a row already broke before the edit is not listed. External
   * schema event that changed tables' entries: the rules the rows of those tables break. Empty
   * when nothing is broken; absent when nothing was checked (an engine event, a body-only change,
   * a check that failed). At most {@link MAX_EVENT_VIOLATIONS}: `violationsTotal` then counts them all.
   */
  violations?: ExternalViolation[];
  /** How many violations there are in all, when `violations` holds only the first ones. */
  violationsTotal?: number;
  /**
   * An engine write that follows hand edits (`operation: "repair_links"`: the links repaired after
   * notes were renamed or moved by hand): those moves, each with the `seq` of its `move` event when
   * the moved note is a row.
   */
  cause?: { path: string; oldPath: string; seq?: number }[];
}

export interface ChangeQuery {
  /** Events after this sequence number (0: from the oldest kept). */
  since?: number;
  /** Only these tables (qualified or short names). */
  tables?: string[];
  ops?: ChangeOp[];
  /** Only updates touching one of these columns (inserts and deletes always match). */
  columns?: string[];
  /**
   * Skip events made by this agent (its `harness`): a service ignores its own writes. A program's
   * own work with its named token has `harness` = the token's name; what it writes for an agent
   * keeps the agent's harness (and the token's name in `auth`), so the program still sees it.
   */
  excludeActor?: string;
  /** Only changes whose row matches (as in select_rows; tested on the values after the change, before it for deletes). */
  where?: Where;
  /** Default 500, at most 5000. */
  limit?: number;
}

export interface ChangePage {
  events: ChangeEvent[];
  /** Pass as `since` next time. */
  last: number;
  /** Newest sequence number: a client that re-reads everything anyway can continue from here. */
  head: number;
  /** Events older than `since` were dropped by retention: re-read the tables. */
  gap?: boolean;
}

/** What recent hand edits left broken (`ChangeFeed.handEditViolations`). */
export interface HandEditSummary {
  /** Hand edits recorded in the time looked at. */
  edits: number;
  /** Rows (or metastore.yaml, for a schema edit) whose latest change is a hand edit breaking rules. */
  rows: number;
  /** The violations of those edits, in all. */
  violations: number;
  /** The newest of them, with the first violation's message. */
  latest: { path: string; table: string | null; at: string; seq: number; violations: number; message: string }[];
}

interface RowState {
  table: string | null;
  id?: string;
  values: Record<string, unknown>;
}

type NewEvent = Omit<ChangeEvent, "seq" | "at">;

/** A vault change waiting for its batch: a path changed (created, modified, deleted) or a rename. */
type PendingOp = { path: string } | { from: string; to: string };

/** What a row of a batch was before it (null: no row), and where, when the batch renamed it. */
interface BatchEntry {
  before: RowState | null;
  oldPath?: string;
}

/** The violations an event carries at most (the rest is counted in `violationsTotal`). */
export const MAX_EVENT_VIOLATIONS = 100;

/** The kind of a change as callers name it: a change of `metastore.yaml` is `metastore`. */
export type ChangeKind = Exclude<ChangeOp, "schema"> | "metastore";

/** A kind as callers name it, as the feed stores it. */
export function opOfKind(kind: string): ChangeOp {
  return (kind === "metastore" ? "schema" : kind) as ChangeOp;
}

/**
 * An event as callers see it (list_changes, the stream, webhooks): snake_case, `kind` the kind of
 * change and `op` the operation that made it. The feed's own file keeps its stored form.
 */
export function wireEvent(e: ChangeEvent): Record<string, unknown> {
  const c = e.call;
  const violations = e.violations === undefined ? undefined : groupViolations(e.violations);
  return {
    seq: e.seq,
    at: e.at,
    table: e.table,
    kind: e.op === "schema" ? "metastore" : e.op,
    ...(e.operation !== undefined ? { op: e.operation } : {}),
    path: e.path,
    ...(e.oldPath !== undefined ? { old_path: e.oldPath } : {}),
    ...(e.id !== undefined ? { row_id: e.id } : {}),
    ...(e.changes !== undefined ? { changes: e.changes } : {}),
    source: e.source,
    ...(e.row !== undefined ? { row: e.row } : {}),
    ...(e.actor !== undefined ? { actor: e.actor } : {}),
    ...(e.migration !== undefined ? { migration_id: e.migration } : {}),
    ...(c
      ? {
          call: {
            tool: c.tool,
            args: c.args,
            ok: c.ok,
            duration_ms: c.durationMs,
            value: c.value,
            ...(c.summary !== undefined ? { summary: c.summary } : {}),
            served_by: c.servedBy,
            ...(c.resultChars !== undefined ? { result_chars: c.resultChars } : {}),
            ...(c.resultTokens !== undefined ? { result_tokens: c.resultTokens } : {}),
            ...(c.session !== undefined ? { session: c.session } : {}),
          },
        }
      : {}),
    ...(violations !== undefined ? { violations } : {}),
    ...(e.violationsTotal !== undefined ? { violations_total: e.violationsTotal } : {}),
    ...(e.cause !== undefined ? { cause: e.cause.map((x) => ({ path: x.path, old_path: x.oldPath, ...(x.seq !== undefined ? { seq: x.seq } : {}) })) } : {}),
  };
}

/** Violations grouped by the row that breaks them, as a write's answer lists them. */
function groupViolations(vs: readonly ExternalViolation[]): { path: string; violations: Omit<ExternalViolation, "path">[] }[] {
  const out = new Map<string, Omit<ExternalViolation, "path">[]>();
  for (const { path, ...v } of vs) {
    if (!out.has(path)) out.set(path, []);
    out.get(path)!.push(v);
  }
  return [...out].map(([path, violations]) => ({ path, violations }));
}

/** A page of events as callers see it. */
export function wirePage(p: ChangePage): Record<string, unknown> {
  return { events: p.events.map(wireEvent), last: p.last, head: p.head, ...(p.gap ? { gap: true } : {}) };
}

const BUFFER = 10_000;
/** The rows' paths are saved this long after a row is created, moved or removed (and when the feed stops). */
const SAVE_PATHS_MS = 10_000;
/** Quiet time after the last vault change before a batch of hand edits is compared. */
const VAULT_DEBOUNCE_MS = 700;
/** A batch waits at most this long after its first change (a sync tool writing for a while). */
const VAULT_MAX_WAIT_MS = 5000;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The events of a day file, in order. A line that is not an event is skipped: the torn last line
 * of an append cut short by a stop by force, or the line the next append glued to it.
 */
export function parseEvents(text: string): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as ChangeEvent;
      if (ev && typeof ev === "object" && typeof ev.seq === "number") out.push(ev);
    } catch {
      // torn: skipped
    }
  }
  return out;
}

function matches(ev: ChangeEvent, q: ChangeQuery): boolean {
  // tool calls are their own stream: only for consumers that ask for them
  if (ev.op === "tool_call" && !q.ops?.includes("tool_call")) return false;
  if (q.tables && q.tables.length > 0) {
    const t = ev.table;
    if (!t || !q.tables.some((x) => t === x || t.endsWith(`.${x}`))) return false;
  }
  if (q.ops && q.ops.length > 0 && !q.ops.includes(ev.op)) return false;
  if (q.columns && q.columns.length > 0 && ev.op === "update" && !Object.keys(ev.changes ?? {}).some((c) => q.columns!.includes(c))) return false;
  if (q.excludeActor && ev.actor?.harness === q.excludeActor) return false;
  return true;
}

export class ChangeFeed {
  private state = new Map<string, RowState>();
  private buffer: ChangeEvent[] = [];
  private seq = 0;
  private oldest = 1;
  private waiters = new Set<() => void>();
  /**
   * Vault changes outside the engine since the last batch, in order (a path once between two
   * renames), and when the first of them happened.
   */
  private pending: PendingOp[] = [];
  private pendingPaths = new Set<string>();
  private pendingSince = 0;
  /** The batch of hand edits being compared: each row's state before it, by its path now. */
  private batch: Map<string, BatchEntry> | null = null;
  /**
   * The batch's changes, the one being compared (`at`), and the rows its later paths create, by
   * id (read once, when a removal first looks for its new path).
   */
  private batchOps: { ops: readonly PendingOp[]; at: number; created: Map<string, { path: string; i: number; table: string | null }[]> | null } | null = null;
  /** Batches of hand edits taken from `pending`, waiting for their turn. */
  private taken: (readonly PendingOp[])[] = [];
  /** The notes the batch of hand edits being compared renamed or moved, in order (rows and plain notes). */
  private batchMoves: HandMove[] = [];
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refs: EventRef[] = [];
  private unsubscribe: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<(ev: ChangeEvent) => void>();
  /** `metastore.yaml` as of the last schema event. */
  private schemaText: string | null = null;

  /** Be told about every event as it is recorded. Returns the unsubscribe. */
  onEvent(fn: (ev: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  constructor(
    private readonly app: App,
    private readonly getSettings: () => DatanotesSettings,
    private readonly retentionDays = 30,
  ) {
    this.repairs = new HandMoveRepairs(app, getSettings);
  }

  /** The links to notes moved by hand, repaired once the vault is quiet (hand-moves.ts). */
  readonly repairs: HandMoveRepairs;
  private savePathsTimer: ReturnType<typeof setTimeout> | undefined;

  /** The rows' paths by id (saved in the store: a row moved while the engine is stopped is found by its id). */
  private rowPaths(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [path, st] of this.state) if (st.id) out.set(st.id, path);
    return out;
  }

  private async saveRowPaths(): Promise<void> {
    if (this.savePathsTimer) clearTimeout(this.savePathsTimer);
    this.savePathsTimer = undefined;
    try {
      await saveRowPaths(this.app, this.rowPaths());
    } catch (e) {
      telemetry().log("WARN", "datanotes could not save the row paths", { error: messageOf(e) });
    }
  }

  private dir(): string {
    return storePath("changes");
  }

  /** Read the last sequence number and the rows' current state, then follow writes and vault events. */
  async start(): Promise<void> {
    const s = this.getSettings();
    this.schemaText = (await loadMetastore(this.app, s))?.text ?? null;
    const files = (await storeList(this.app, this.dir())).files.filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of [...files].reverse()) {
      /* v8 ignore next -- a race: a file listed a moment ago was removed (pruned) before this read */
      const text = (await storeRead(this.app, f)) ?? "";
      // a stop by force in the middle of an append leaves a torn last line: the next event
      // starts on a line of its own
      if (f === files[files.length - 1] && text !== "" && !text.endsWith("\n")) {
        try {
          await storeAppend(this.app, f, "\n");
        } catch {
          // read around it all the same
        }
      }
      const events = parseEvents(text);
      const last = events[events.length - 1];
      if (last) {
        this.seq = last.seq;
        break;
      }
    }
    if (files.length > 0) {
      /* v8 ignore next -- a race: a file listed a moment ago was removed (pruned) before this read */
      const first = parseEvents((await storeRead(this.app, files[0]!)) ?? "")[0];
      this.oldest = first ? first.seq : this.seq + 1;
    } else this.oldest = this.seq + 1;
    // Rows are read the same way here and when diffing, so values compare equal.
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm || fm[s.tableKey] === undefined) continue;
      try {
        const st = await this.readState(f.path);
        if (st && st !== "missing") this.state.set(f.path, st);
      } catch (e) {
        // a note that cannot be read (broken frontmatter) is compared again on its next change
        telemetry().log("WARN", "datanotes change feed could not read a note", { path: f.path, error: messageOf(e) });
      }
    }
    // rows moved by hand while the engine was stopped (found by id): their links are repaired too
    await this.repairs.add(await rowMovesSince(this.app, this.rowPaths()), new Set());
    await this.saveRowPaths();
    this.unsubscribe = onApplied(this.app, (e) => this.enqueue(() => this.fromEngine(e)));
    const v = this.app.vault as unknown as { on?(n: string, cb: (...a: never[]) => unknown): EventRef };
    if (typeof v.on !== "function") return;
    const touch = ((f: TAbstractFile) => this.touch(f.path)) as never;
    this.refs.push(v.on("create", touch), v.on("modify", touch), v.on("delete", touch));
    this.refs.push(
      v.on("rename", ((f: TAbstractFile, old: string, info?: unknown) => {
        // engine moves come from onApplied; one the host saw on disk is a hand move, also while the engine writes
        if (!engineWriting(this.app) || externalRename(info)) this.moved(old, f.path);
        else this.repairs.activity();
      }) as never),
    );
  }

  /**
   * Stop following the vault and the engine. The hand edits already seen are compared first (their
   * events recorded, so listeners such as webhooks get them); nothing is recorded after.
   */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const v = this.app.vault as unknown as { offref?(ref: EventRef): void };
    for (const r of this.refs) v.offref?.(r);
    this.refs = [];
    if (!this.stopped) {
      await this.flush();
      await this.repairs.stop();
      await this.queue; // the repair's events
      await this.saveRowPaths();
    }
    this.stopped = true;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** Changes are computed one at a time, in order; settled once this one is recorded (or failed). */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.queue = this.queue.then(fn).catch((e: unknown) => {
      telemetry().log("WARN", "datanotes change feed could not record a change", { error: messageOf(e) });
    });
    return this.queue;
  }

  /** A path changed outside the engine (vault event): compared with its last state shortly, with the others changed meanwhile. */
  touch(path: string): void {
    if (this.stopped) return;
    this.repairs.activity();
    if (!this.pendingPaths.has(path)) {
      this.pending.push({ path });
      this.pendingPaths.add(path);
    }
    this.schedule();
  }

  /** A note renamed outside the engine (vault event): in the same batch, in order with the other changes. */
  moved(from: string, to: string): void {
    if (this.stopped) return;
    this.repairs.activity();
    this.pending.push({ from, to });
    this.pendingPaths.clear(); // a path changed after the rename is compared after it
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.pendingSince ||= Date.now();
    const wait = Math.max(0, Math.min(VAULT_DEBOUNCE_MS, this.pendingSince + VAULT_MAX_WAIT_MS - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // During an engine write the change is its own: wait, then the diff finds nothing new. While
      // held (the metastore went away: the database folder may have moved), wait too.
      if (engineWriting(this.app) || this.held) {
        this.pendingSince = Date.now();
        this.schedule();
      } else this.takePending();
    }, wait);
  }

  private held = false;

  /**
   * Keep the hand edits seen from now on until {@link release}: the metastore went away, and the
   * database folder may have moved (its rows are then moved, not deleted: {@link databaseMoved}).
   */
  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
    if (this.pending.length > 0) this.schedule();
  }

  /**
   * The database folder moved from `from` to `to`: a `schema` event (with `oldPath`) and, when the
   * feed was following the rows (`rows`: a move while running), one `move` event for each row,
   * instead of the deletes and inserts the vault's events would give. The move is one operation
   * (links repaired and generated columns recomputed with it): each row is read as it is after it,
   * so the vault changes of the move itself are no events of their own.
   */
  databaseMoved(from: string, to: string, rows: boolean, meta: Partial<ChangeEvent> & { source: ChangeEvent["source"] } = { source: "external", operation: "move_database" }, entries: readonly string[] = []): Promise<void> {
    return this.enqueue(() => this.databaseMovedNow(from, to, rows, meta, entries));
  }

  private async databaseMovedNow(from: string, to: string, rows: boolean, meta: Partial<ChangeEvent> & { source: ChangeEvent["source"] }, entries: readonly string[] = []): Promise<void> {
    // a case-only rename keeps paths that differ in case only: compared as they are written; from
    // the root, the database's names moved (`entries`)
    const inside = (p: string) => (from === "" ? entries.includes(p.split("/")[0]!) : p === from || p.startsWith(`${from}/`));
    {
      const out: NewEvent[] = [];
      if (rows) {
        this.pending = this.pending.filter((op) => !("from" in op ? inside(op.from) : inside(op.path)));
        this.pendingPaths = new Set(this.pending.flatMap((op) => ("path" in op ? [op.path] : [])));
        for (const [path, st] of [...this.state]) {
          if (!inside(path)) continue;
          const next = movePath(path, from, to, entries);
          this.state.delete(path);
          let cur: RowState | null | "missing" = null;
          try {
            cur = await this.readState(next);
          } catch {
            cur = null; // read again on its next change
          }
          const now = cur && cur !== "missing" ? cur : st;
          this.state.set(next, now);
          out.push({ table: now.table, op: "move", path: next, oldPath: path, ...(now.id ? { id: now.id } : {}), row: now.values, ...meta });
        }
      }
      this.excluded = null;
      const s = this.getSettings();
      this.schemaText = (await loadMetastore(this.app, s))?.text ?? this.schemaText;
      out.unshift({ table: null, op: "schema", path: metastorePath(s), oldPath: inDatabase(from, METASTORE_FILE), ...meta });
      await this.emitAll(out);
    }
  }

  private takePending(): void {
    const ops = this.pending;
    this.pending = [];
    this.pendingPaths.clear();
    this.pendingSince = 0;
    if (ops.length === 0) return;
    this.taken.push(ops);
    void this.enqueue(() => {
      this.taken = this.taken.filter((x) => x !== ops);
      return this.external(ops);
    });
  }

  /** Settle pending work (tests, shutdown): the hand edits seen, then the links to notes moved by hand (unless the vault is busy). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.takePending();
    await this.queue;
    await this.repairs.flush();
    await this.queue;
  }

  /**
   * A batch of vault changes made outside the engine, in order: their events, with what the edits
   * break. A note that cannot be compared (unreadable frontmatter, a failed read) is skipped with
   * a WARN naming it; the rest of the batch is recorded.
   */
  private async external(ops: readonly PendingOp[]): Promise<void> {
    const out: NewEvent[] = [];
    const schemaBefore = this.schemaText;
    const batch = (this.batch = new Map());
    this.batchOps = { ops, at: 0, created: null };
    this.batchMoves = [];
    try {
      for (const [i, op] of ops.entries()) {
        this.batchOps.at = i;
        try {
          if ("from" in op) await this.renamed(op.from, op.to, { source: "external" }, out);
          else await this.diff(op.path, { source: "external" }, out);
        } catch (e) {
          const path = "from" in op ? op.to : op.path;
          telemetry().log("WARN", "datanotes change feed could not read a hand-edited note", { path, ...("from" in op ? { old_path: op.from } : {}), error: messageOf(e) });
        }
      }
    } finally {
      this.batch = null;
      this.batchOps = null;
    }
    // notes moved by hand: the links to their old paths are repaired once the vault is quiet
    // (their events come after the batch's); the notes the batch changed may have new links
    const moves = this.batchMoves;
    this.batchMoves = [];
    const follow = (await this.repairs.add(moves, new Set(ops.flatMap((op) => ("path" in op ? [op.path] : []))))) ? new Set(moves.map((m) => m.from)) : undefined;
    await this.publish(out, batch, schemaBefore, follow);
  }

  /** A row's state as frontmatter (its `table` first), as the checks read it. */
  private ordered(st: RowState): [string, unknown][] {
    return [[this.getSettings().tableKey, st.table], ...Object.entries(st.values)];
  }

  /**
   * Record the events of a batch of hand edits: the last insert, update, move or delete event of
   * each row carries what the edit breaks (see checkExternalEdits: its row's rules, and those of
   * the rows linking to it, a rename or a removal included; a rule broken before is not listed);
   * an external schema event that changed tables' entries carries what the rows of those tables
   * break. A WARN log line counts them.
   */
  private async publish(out: NewEvent[], batch: ReadonlyMap<string, BatchEntry>, schemaBefore: string | null, follow?: ReadonlySet<string>): Promise<void> {
    const s = this.getSettings();
    const last = new Map<string, number>();
    out.forEach((e, i) => {
      if (e.source === "external" && e.table && (e.op === "insert" || e.op === "update" || e.op === "move" || e.op === "delete")) last.set(e.path, i);
    });
    if (last.size > 0) {
      const edits: ExternalEdit[] = [...last.keys()].map((path) => {
        const b = batch.get(path);
        return {
          path,
          ...(b?.oldPath !== undefined && b.oldPath !== path ? { oldPath: b.oldPath } : {}),
          before: b === undefined ? undefined : b.before ? this.ordered(b.before) : null,
          ...(this.state.has(path) ? {} : { gone: true }),
          ...(b?.oldPath !== undefined && follow?.has(b.oldPath) ? { linksFollow: true } : {}),
        };
      });
      try {
        const { byPath, tableOf } = await checkExternalEdits(this.app, s, edits);
        const rows = new Set<string>();
        const tables = new Set<string>();
        let n = 0;
        for (const [path, i] of last) {
          const violations = byPath.get(path) ?? [];
          out[i] = { ...out[i]!, ...capped(violations) };
          n += violations.length;
          for (const v of violations) {
            rows.add(v.path);
            tables.add(tableOf.get(v.path) ?? out[i]!.table!);
          }
        }
        if (n > 0) {
          telemetry().log("WARN", "datanotes hand edits break table rules", { edited_rows: last.size, violating_rows: rows.size, violations: n, tables: [...tables].sort().join(", ") });
        }
      } catch (e) {
        telemetry().log("WARN", "datanotes could not check hand edits", { rows: last.size, error: messageOf(e) });
      }
    }
    const schema = out.map((e, i) => [e, i] as const).filter(([e]) => e.source === "external" && e.op === "schema").pop()?.[1];
    if (schema !== undefined) {
      const changed = changedTables(schemaBefore, this.schemaText);
      if (changed.length > 0) {
        const { byTable, errors } = await checkChangedTables(this.app, s, changed);
        const violations = [...byTable.values()].flat();
        if (errors.size === 0) out[schema] = { ...out[schema]!, ...capped(violations) };
        for (const [table, error] of errors) telemetry().log("WARN", "datanotes could not check a table changed by hand", { table, error });
        if (violations.length > 0) {
          const broken = [...byTable].filter(([, v]) => v.length > 0).map(([t]) => t);
          telemetry().log("WARN", "datanotes hand edit of metastore.yaml breaks table rules", {
            tables: broken.sort().join(", "),
            violating_rows: new Set(violations.map((v) => v.path)).size,
            violations: violations.length,
          });
        }
      }
    }
    for (const e of out) await this.emit(e);
  }

  /** Emit an event now, or add it to a batch (`out`) recorded later. */
  private async record(e: NewEvent, out?: NewEvent[]): Promise<void> {
    if (out) out.push(e);
    else await this.emit(e);
  }

  /** Archive and `exclude` folders of each table: a note there is not a row (as check_table and the transaction log read them). */
  private excluded: { model: Metastore; byTable: Map<string, string[]> } | null = null;

  private excludedOf(model: Metastore, table: string): string[] | undefined {
    if (this.excluded?.model !== model) {
      const s = this.getSettings();
      const byTable = new Map<string, string[]>();
      for (const { ref, entry } of catalogTables(model)) {
        const options = parseTableOptions(entryToOrdered(ref, entry, s).find(([k]) => k === TABLE_KEY)?.[1]);
        byTable.set(ref.full, [...(options.exclude ?? []), catalogLayout(normalizeDatabaseFolder(s.databaseFolder), ref, options).archive]);
      }
      this.excluded = { model, byTable };
    }
    return this.excluded.byTable.get(table);
  }

  private rowState(path: string, fm: Record<string, unknown>): RowState | null {
    const s = this.getSettings();
    const model = cachedMetastore(this.app, s);
    const table = model ? rowTableFull(model, fm[s.tableKey]) : null;
    if (!table) return null;
    if ((this.excludedOf(model!, table) ?? []).some((dir) => path.startsWith(`${dir}/`))) return null;
    const { [s.tableKey]: _t, position: _p, ...values } = fm;
    return { table, ...(typeof fm.id === "string" ? { id: fm.id } : {}), values };
  }

  private async readState(path: string): Promise<RowState | null | "missing"> {
    const ordered = await readRowFrontmatter(this.app, this.getSettings(), path);
    if (ordered === null) return "missing";
    return this.rowState(path, Object.fromEntries(ordered));
  }

  /** The hand moves an engine write follows, with the `seq` of their `move` events (rows). */
  private causeOf(moves: readonly HandMove[]): NonNullable<ChangeEvent["cause"]> {
    return moves.map(({ from, to }) => {
      const ev = [...this.buffer].reverse().find((x) => x.op === "move" && x.source === "external" && x.path === to && x.oldPath === from);
      return { path: to, oldPath: from, ...(ev ? { seq: ev.seq } : {}) };
    });
  }

  private async fromEngine(e: AppliedOperation): Promise<void> {
    const meta = {
      source: "engine" as const,
      ...(e.actor ? { actor: e.actor } : {}),
      ...(e.migrationId ? { migration: e.migrationId } : {}),
      operation: e.op,
      ...(e.handMoves ? { cause: this.causeOf(e.handMoves) } : {}),
    };
    if (e.databaseMove) {
      await this.databaseMovedNow(e.databaseMove.from, e.databaseMove.to, true, { ...meta, source: e.databaseMove.by === "hand" ? "external" : "engine" }, e.databaseMove.entries);
      return;
    }
    for (const m of e.moves) await this.renamed(m.from, m.to, meta);
    for (const p of new Set([...e.paths, ...e.deletes])) await this.diff(p, meta);
  }

  private async renamed(from: string, to: string, meta: Partial<ChangeEvent> & { source: ChangeEvent["source"] }, out?: NewEvent[]): Promise<void> {
    if (this.batch) this.batchMoves.push({ from, to }); // a hand move, of a row or of a plain note
    const prev = this.state.get(from);
    if (!prev) {
      // The metastore renamed away is gone, as if deleted (one renamed onto it is diffed below).
      if (from === metastorePath(this.getSettings())) await this.diff(from, meta, out);
      await this.diff(to, meta, out);
      return;
    }
    const was = this.batch ? this.batch.get(from) ?? { before: prev } : undefined;
    this.state.delete(from);
    const cur = await this.readState(to);
    if (cur === null || cur === "missing") {
      // moved out of the table (e.g. archived by delete_rows): gone for consumers
      if (this.batch && !this.batch.has(from)) this.batch.set(from, was!);
      await this.record({ table: prev.table, op: "delete", path: from, ...(prev.id ? { id: prev.id } : {}), changes: this.values(prev.values, "before"), row: prev.values, ...meta }, out);
      return;
    }
    if (this.batch) {
      this.batch.delete(from);
      this.batch.set(to, { before: was!.before, oldPath: was!.oldPath ?? from });
    }
    this.state.set(to, prev);
    await this.record({ table: prev.table, op: "move", path: to, oldPath: from, ...(prev.id ? { id: prev.id } : {}), row: prev.values, ...meta }, out);
    await this.diff(to, meta, out);
  }

  /**
   * The `unreadable` event of a note whose front matter cannot be read: a row known to the feed,
   * or a note whose `table:` line names a table. Null when the note can be read (the failure was
   * something else) or is no row.
   */
  private async unreadableEvent(path: string, meta: Partial<ChangeEvent> & { source: ChangeEvent["source"] }): Promise<NewEvent | null> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !("extension" in f)) return null;
    let text: string;
    try {
      text = (await readHashed(this.app, f as TFile)).content;
    } catch {
      return null;
    }
    const error = frontmatterError(text);
    if (error === null) return null;
    const prev = this.state.get(path);
    const model = cachedMetastore(this.app, this.getSettings());
    const named = model ? unreadableRowOf(model, this.getSettings(), path, text) : null;
    const table = named?.table ?? prev?.table ?? null;
    if (!table) return null;
    return {
      table,
      op: "unreadable",
      path,
      ...(prev?.id ? { id: prev.id } : {}),
      ...meta,
      violations: [{ path, code: "unreadable", message: unreadableMessage(error) }],
    };
  }

  /** A hand rename of `path` still to be compared: later in the batch being compared, or in one to come. */
  private renamedLater(path: string): { from: string; to: string } | undefined {
    const ops = this.batchOps ? this.batchOps.ops.slice(this.batchOps.at + 1) : [...this.taken.flat(), ...this.pending];
    return ops.find((op): op is { from: string; to: string } => "from" in op && op.from === path);
  }

  /** Compare a path with its last known state and record what changed. */
  private async diff(path: string, meta: Partial<ChangeEvent> & { source: ChangeEvent["source"] }, out?: NewEvent[]): Promise<void> {
    if (path === metastorePath(this.getSettings())) {
      // Loaded before its text is recorded: a metastore that cannot be read (broken YAML, a failed
      // read) is no event, and is compared again on its next change.
      const text = (await loadMetastore(this.app, this.getSettings()))?.text ?? null;
      // the vault event of the engine's own write arrives after it: same text, nothing new
      if (text !== null && text === this.schemaText) return;
      this.schemaText = text;
      await this.record({ table: null, op: "schema", path, ...meta }, out);
      return;
    }
    if (!path.endsWith(".md")) return;
    let cur: Awaited<ReturnType<ChangeFeed["readState"]>>;
    try {
      cur = await this.readState(path);
    } catch (e) {
      // front matter that cannot be read: an `unreadable` event, the row's last state kept (its
      // fix is compared with it); any other failure (a read refused) is the caller's WARN
      const ev = await this.unreadableEvent(path, meta);
      if (!ev) throw e;
      if (this.batch && !this.batch.has(path)) this.batch.set(path, { before: this.state.get(path) ?? null });
      telemetry().log("WARN", "datanotes hand edit left a row unreadable", { path, table: ev.table, error: ev.violations![0]!.message });
      await this.record(ev, out);
      return;
    }
    let prev = this.state.get(path) ?? null;
    if (this.batch && !this.batch.has(path)) this.batch.set(path, { before: prev });
    let now = cur === "missing" ? null : cur;
    // gone from here, and renamed by hand after this change: the rename records the move
    const movedOn = prev && cur === "missing" ? this.renamedLater(path) : undefined;
    if (movedOn && this.batch) return; // later in this batch
    if (movedOn) {
      // an engine write, then a hand move before it was read: compared where the row is now (the
      // move is recorded with its batch, after this event)
      const there = await this.readState(movedOn.to);
      if (there && there !== "missing") now = there;
    }
    if (!prev && !now) return;
    if (!prev && now?.id) {
      // A rename seen as delete + create (from disk, git, a sync tool): the same row moved.
      const from = [...this.state].find(([p, st]) => st.id === now.id && st.table === now.table && p !== path && !this.app.vault.getAbstractFileByPath(p))?.[0];
      if (from) {
        prev = this.state.get(from)!;
        if (this.batch) {
          const was = this.batch.get(from) ?? { before: prev };
          this.batch.delete(from);
          this.batch.set(path, { before: was.before, oldPath: was.oldPath ?? from });
          this.batchMoves.push({ from, to: path });
        }
        this.state.delete(from);
        this.state.set(path, prev);
        await this.record({ table: prev.table, op: "move", path, oldPath: from, id: now.id, row: now.values, ...meta }, out);
      }
    }
    if (!prev && now) {
      this.state.set(path, now);
      await this.record({ table: now.table, op: "insert", path, ...(now.id ? { id: now.id } : {}), changes: this.values(now.values, "after"), row: now.values, ...meta }, out);
      return;
    }
    if (prev && !now) {
      // A rename seen as delete, then create (the headless host's watcher reports the old path
      // first): the row the batch creates later with the same id is this one, moved.
      const to = cur === "missing" ? await this.createdLater(prev) : undefined;
      if (to) {
        await this.renamed(path, to, meta, out);
        return;
      }
      this.state.delete(path);
      await this.record({ table: prev.table, op: "delete", path, ...(prev.id ? { id: prev.id } : {}), changes: this.values(prev.values, "before"), row: prev.values, ...meta }, out);
      return;
    }
    const a = prev!;
    const b = now!;
    this.state.set(path, b);
    if (a.table !== b.table) {
      await this.record({ table: a.table, op: "delete", path, ...(a.id ? { id: a.id } : {}), changes: this.values(a.values, "before"), row: a.values, ...meta }, out);
      await this.record({ table: b.table, op: "insert", path, ...(b.id ? { id: b.id } : {}), changes: this.values(b.values, "after"), row: b.values, ...meta }, out);
      return;
    }
    const changes: ChangeEvent["changes"] = {};
    for (const k of new Set([...Object.keys(a.values), ...Object.keys(b.values)])) {
      if (!same(a.values[k], b.values[k])) changes[k] = { ...(k in a.values ? { before: a.values[k] } : {}), ...(k in b.values ? { after: b.values[k] } : {}) };
    }
    if (Object.keys(changes).length === 0) return; // body-only edit, or our own write already recorded
    await this.record({ table: b.table, op: "update", path, ...(b.id ? { id: b.id } : {}), changes, row: b.values, ...meta }, out);
  }

  /** The path a later change of the batch creates the row at (same table and id, not known before), if any. */
  private async createdLater(prev: RowState): Promise<string | undefined> {
    const b = this.batchOps;
    if (!b || !prev.id) return undefined;
    if (!b.created) {
      b.created = new Map();
      for (const [i, op] of b.ops.entries()) {
        if ("from" in op || !op.path.endsWith(".md") || this.state.has(op.path) || !this.app.vault.getAbstractFileByPath(op.path)) continue;
        try {
          const st = await this.readState(op.path);
          if (st && st !== "missing" && st.id) b.created.set(st.id, [...(b.created.get(st.id) ?? []), { path: op.path, i, table: st.table }]);
        } catch {
          // compared (and reported) on its own turn
        }
      }
    }
    return b.created.get(prev.id)?.find((c) => c.i > b.at && c.table === prev.table && !this.state.has(c.path) && this.app.vault.getAbstractFileByPath(c.path))?.path;
  }

  private values(v: Record<string, unknown>, side: "before" | "after"): ChangeEvent["changes"] {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { [side]: x }]));
  }

  private emit(e: NewEvent): Promise<void> {
    return this.emitAll([e]);
  }

  /** Record events in order: one append to the store for all of them (a move of the database folder records thousands). */
  private async emitAll(events: readonly NewEvent[]): Promise<void> {
    if (this.stopped || events.length === 0) return;
    const evs: ChangeEvent[] = events.map((e) => ({ seq: ++this.seq, at: new Date().toISOString(), ...e }));
    // rows created, moved or removed: their paths are saved again shortly
    if (!this.savePathsTimer && evs.some((e) => e.op === "insert" || e.op === "move" || e.op === "delete")) {
      this.savePathsTimer = setTimeout(() => void this.enqueue(() => this.saveRowPaths()), SAVE_PATHS_MS);
    }
    this.buffer.push(...evs);
    if (this.buffer.length > BUFFER) this.buffer.splice(0, this.buffer.length - BUFFER);
    const byDay = new Map<string, string[]>();
    for (const ev of evs) {
      const day = ev.at.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(ev)]);
    }
    for (const [day, lines] of byDay) {
      try {
        await storeAppend(this.app, storePath("changes", `${day}.jsonl`), `${lines.join("\n")}\n`);
      } catch {
        // the events are still served from memory
      }
    }
    for (const w of [...this.waiters]) w();
    for (const ev of evs) {
      for (const fn of this.listeners) {
        try {
          fn(ev);
        } catch {
          // a listener's problem is its own
        }
      }
    }
  }

  /** Record an MCP tool call (in order with the row changes); settled once it is in the feed. */
  recordToolCall(call: ToolCallInfo, actor?: Actor): Promise<void> {
    return this.enqueue(() => this.emit({ table: null, op: "tool_call", path: "", source: "engine", ...(actor ? { actor } : {}), call }));
  }

  get lastSeq(): number {
    return this.seq;
  }

  /**
   * The hand edits recorded since `since` (ms) and the rows they leave breaking the tables' rules:
   * a row counts when its latest change in that time is a hand edit whose check found violations
   * (a later change of the row, by hand or by the engine, clears it). Reads only the day files
   * from `since` on; nothing is checked again.
   */
  async handEditViolations(since: number, limit = 20): Promise<HandEditSummary> {
    const fromDay = new Date(since).toISOString().slice(0, 10);
    const latest = new Map<string, ChangeEvent>();
    let edits = 0;
    for (const f of (await storeList(this.app, this.dir())).files.filter((x) => x.endsWith(".jsonl")).sort()) {
      const day = /(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1];
      if (!day || day < fromDay) continue;
      /* v8 ignore next -- a race: a file listed a moment ago was removed (pruned) before this read */
      for (const ev of parseEvents((await storeRead(this.app, f)) ?? "")) {
        if (ev.op === "tool_call" || Date.parse(ev.at) < since) continue;
        if (ev.source === "external") edits++;
        if (ev.oldPath) latest.delete(ev.oldPath);
        latest.set(ev.path, ev);
      }
    }
    const broken = [...latest.values()].filter((e) => e.source === "external" && (e.violations?.length ?? 0) > 0).sort((a, b) => b.seq - a.seq);
    const count = (e: ChangeEvent) => e.violationsTotal ?? e.violations!.length;
    return {
      edits,
      rows: broken.length,
      violations: broken.reduce((n, e) => n + count(e), 0),
      latest: broken.slice(0, limit).map((e) => ({ path: e.path, table: e.table, at: e.at, seq: e.seq, violations: count(e), message: e.violations![0]!.message })),
    };
  }

  /** Events after `since` that match the query. */
  async read(q: ChangeQuery = {}): Promise<ChangePage> {
    const since = q.since ?? 0;
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
    let source: ChangeEvent[];
    if (this.buffer.length > 0 && since >= this.buffer[0]!.seq - 1) source = this.buffer.filter((e) => e.seq > since);
    else {
      source = [];
      for (const f of (await storeList(this.app, this.dir())).files.filter((x) => x.endsWith(".jsonl")).sort()) {
        /* v8 ignore next -- a race: a file listed a moment ago was removed (pruned) before this read */
        for (const ev of parseEvents((await storeRead(this.app, f)) ?? "")) if (ev.seq > since) source.push(ev);
      }
    }
    // `where` is compiled only for the tables the other filters keep: a column of `film` is not
    // an error on the `watch` events of the same batch
    const rowMatches = await this.wherePredicates(
      q.where,
      source.filter((ev) => matches(ev, q)),
    );
    const events: ChangeEvent[] = [];
    let last = since;
    for (const ev of source) {
      last = ev.seq;
      if (matches(ev, q) && rowMatches(ev)) events.push(ev);
      if (events.length >= limit) break;
    }
    if (events.length < limit) last = Math.max(last, Math.min(this.seq, source.length ? source[source.length - 1]!.seq : since));
    return { events, last: Math.max(last, since), head: this.seq, ...(since > 0 && since < this.oldest - 1 ? { gap: true } : {}) };
  }

  /** `where` compiled per table (as select_rows does); events without row values never match it. */
  private async wherePredicates(where: Where | undefined, events: ChangeEvent[]): Promise<(ev: ChangeEvent) => boolean> {
    if (!where || Object.keys(where).length === 0) return () => true;
    const s = this.getSettings();
    const preds = new Map<string, (row: LoadedRow) => boolean>();
    for (const table of new Set(events.map((e) => e.table).filter((t): t is string => !!t))) {
      try {
        const t = await loadTable(this.app, s, table);
        preds.set(table, compileWhere(where, t, s, rowGetter(this.app, t, s)));
      } catch (e) {
        // a table dropped since: its events do not match; a bad `where` is the caller's error
        if (e instanceof Error && /where|column|operator/i.test(e.message)) throw e;
      }
    }
    return (ev) => {
      const pred = ev.table ? preds.get(ev.table) : undefined;
      if (!pred || !ev.row) return false;
      const name = ev.path.split("/").pop()!;
      const file = { path: ev.path, name, basename: name.replace(/\.md$/, ""), extension: "md" } as LoadedRow["file"];
      return pred({ file, ordered: Object.entries({ [s.tableKey]: ev.table, ...ev.row }), body: "" });
    };
  }

  /** When {@link endWaits} last ended the long polls (ms since the epoch). */
  private waitsEnded = 0;

  /**
   * End the long polls under way (the engine stops): each answers at once with what it has. A wait
   * that starts afterwards waits as usual.
   */
  endWaits(): void {
    this.waitsEnded = Date.now();
    for (const w of [...this.waiters]) w();
  }

  /** Like `read`, but waits up to `waitMs` for a matching event when there is none yet (long poll). */
  async wait(q: ChangeQuery, waitMs: number): Promise<ChangePage> {
    const started = Date.now();
    const deadline = started + Math.min(Math.max(waitMs, 0), 60_000);
    let page = await this.read(q);
    let since = page.last;
    while (page.events.length === 0 && Date.now() < deadline && this.waitsEnded < started) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, deadline - Date.now());
        const self = this;
        function done() {
          clearTimeout(t);
          self.waiters.delete(done);
          resolve();
        }
        this.waiters.add(done);
      });
      page = await this.read({ ...q, since });
      since = page.last;
    }
    return page;
  }

  /** Drop change files older than the retention. */
  async prune(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString().slice(0, 10);
    let n = 0;
    for (const f of (await storeList(this.app, this.dir())).files) {
      const day = /(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1];
      if (day && day < cutoff) {
        await storeRemove(this.app, f);
        n++;
      }
    }
    return n;
  }
}

/** The violations an event carries, at most {@link MAX_EVENT_VIOLATIONS} (`violationsTotal` counts them all then). */
function capped(violations: ExternalViolation[]): Pick<ChangeEvent, "violations" | "violationsTotal"> {
  return violations.length > MAX_EVENT_VIOLATIONS ? { violations: violations.slice(0, MAX_EVENT_VIOLATIONS), violationsTotal: violations.length } : { violations };
}

/** Tables whose entry `next` (a metastore.yaml text) has and `prev` lacks or has otherwise. */
function changedTables(prev: string | null, next: string | null): string[] {
  if (next === null) return [];
  let after: Metastore;
  let before: Metastore | null = null;
  try {
    after = parseMetastore(next);
  } catch {
    return [];
  }
  try {
    before = prev === null ? null : parseMetastore(prev);
  } catch {
    // the earlier text could not be read: every table counts as changed
  }
  const was = new Map(before ? catalogTables(before).map(({ ref, entry }) => [ref.full, JSON.stringify(entry)] as const) : []);
  return catalogTables(after)
    .filter(({ ref, entry }) => was.get(ref.full) !== JSON.stringify(entry))
    .map(({ ref }) => ref.full)
    .sort();
}
