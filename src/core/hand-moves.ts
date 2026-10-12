/**
 * Links after a hand move. A note renamed or moved outside the engine (in a file manager, by git or
 * a sync tool) leaves the links to its old path broken: the engine rewrites them across the vault,
 * plain notes included, as it does when it renames a note itself (the host's `linksAfterMove`
 * computes them as `renameFile` would). The repair is one operation tied to the hand move: one
 * journal entry (`repair_links`, which undo takes back), one commit in the history of every table
 * with rows it wrote (`REPAIR LINKS`, after the hand move's own `EXTERNAL_EDIT`), and change-feed
 * events that name the move they follow (`cause`). Links an editor already rewrote (Obsidian does on
 * its own renames) point to the new path: nothing is written then. The setting
 * `repairLinksOnHandMove` turns it off.
 *
 * When the repair runs ({@link HandMoveRepairs}): once the vault has been quiet for
 * {@link HAND_MOVE_TIMING} (no vault event at all), so an editor that rewrites links after its own
 * rename (Obsidian with "Automatically update internal links") finishes first and the repair only
 * fixes what it left; never while the host says the vault is busy ({@link setRepairGate}: a git
 * pull, rebase or merge under way), when the moves wait for the next try. The plan is made right
 * before writing, and thrown away when a vault event arrives meanwhile.
 *
 * Rows moved while the engine was stopped: the row paths are saved by id in the store
 * ({@link saveRowPaths}), and a row found at another path at the next start is a hand move
 * ({@link rowMovesSince}). Plain notes moved while the engine was stopped have no id: their links
 * are not repaired.
 */

import type { App, LinkRewrite, RenameInfo } from "./host";
import type { DatanotesSettings } from "./settings";
import { fileOrNull, type JournalReference } from "./changeset";
import { eachLimit, MOVE_WRITES } from "./database-move";
import { logEngineWrite, logHandEditsFirst, notifyApplied, whileWriting } from "./engine";
import { invalidateFiles } from "./file-cache";
import { writeJournal } from "./journal";
import { storePath, storeRead, storeWrite } from "./store";
import { withLogLock } from "./transaction-log";
import { bulkWrite } from "./vault-settle";
import { telemetry } from "./telemetry";
import { messageOf } from "./message";

/** A file renamed or moved outside the engine. */
export interface HandMove {
  from: string;
  to: string;
}

/** What {@link repairHandMoves} wrote. */
export interface RepairedLinks {
  /** The journal entry (op `repair_links`). */
  migrationId: string;
  /** Notes whose links were rewritten. */
  paths: string[];
  /** The moves the repair follows (a chain a → b → c as a → c). */
  moves: HandMove[];
}

/** Options of {@link repairHandMoves}. */
export interface RepairOptions {
  /**
   * A move whose old path holds another file again (a → b, then c → a): whether the links to it in
   * a note (its path and text now) meant the file that moved away (see `linksAfterMove`).
   */
  reoccupied?: (from: string, note: string, text: string) => boolean;
  /** Asked once the plan is made, right before the first write: false writes nothing (the plan is stale). */
  beforeWrite?: () => boolean;
}

/** From this many notes on, the repair writes as the host runs bulk writes (the Node service stops watching meanwhile). */
const BULK_FROM = 50;

/**
 * How long the vault must be quiet before a repair is planned, and how long to wait again when the
 * host says the vault is busy (ms). 4 s: an editor's own link rewrite after a rename (Obsidian
 * writes every linking note within a second or two) and a sync tool's burst are over by then.
 */
export const HAND_MOVE_TIMING = { quietMs: 4000, retryMs: 1000 };

/**
 * The moves of a batch, in the order they happened, as where each file was before the batch and
 * where it is now: a → b then b → c is a → c, and a file moved back to where it was is no move.
 */
export function netMoves(moves: readonly HandMove[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { from, to } of moves) {
    const origin = [...out].find(([, now]) => now === from)?.[0];
    out.set(origin ?? from, to);
  }
  for (const [from, to] of out) if (from === to) out.delete(from);
  return out;
}

/**
 * Whether a vault `rename` event's third argument says another program made the rename (the host
 * saw it on disk, see `RenameInfo`): a hand move, also when it is seen while the engine writes.
 */
export function externalRename(info: unknown): boolean {
  return typeof info === "object" && info !== null && (info as RenameInfo).external === true;
}

/** "a.md to b.md", or the first move and how many more. */
function described(moves: readonly HandMove[]): string {
  const first = `${moves[0]!.from} to ${moves[0]!.to}`;
  return moves.length === 1 ? first : `${first} and ${moves.length - 1} more`;
}

/**
 * Rewrite the links that still point to the old paths of files moved by hand (in the order they
 * moved), as one journaled operation. Null when there is nothing to write: the setting is off, the
 * host cannot resolve links as before the move, no note links to an old path any more, or
 * `options.beforeWrite` said the plan is stale. A note changed between the plan and its write (an
 * editor relinking it) is left as it is.
 */
export async function repairHandMoves(app: App, settings: DatanotesSettings, moves: readonly HandMove[], now: Date = new Date(), options: RepairOptions = {}): Promise<RepairedLinks | null> {
  const linksAfterMove = app.fileManager.linksAfterMove?.bind(app.fileManager);
  if (!settings.repairLinksOnHandMove || !linksAfterMove) return null;
  const moved = netMoves(moves);
  if (moved.size === 0) return null;
  return whileWriting(app, () =>
    withLogLock(app, async () => {
      const plan = await linksAfterMove(moved, options.reoccupied ? { reoccupied: options.reoccupied } : {});
      if (plan.length === 0 || options.beforeWrite?.() === false) return null;
      // the hand moves are hand edits: committed first, so the repair's commit holds only its writes
      await logHandEditsFirst(app, settings, now);
      const written: JournalReference[] = [];
      const write = async (r: LinkRewrite) => {
        const f = fileOrNull(app, r.path);
        if (!f) return;
        try {
          await app.vault.process(f, (text) => {
            if (text !== r.before) throw new Error(`${r.path} changed since it was read`);
            return r.after;
          });
          written.push({ path: r.path, before_text: r.before, after_text: r.after });
        } catch (e) {
          telemetry().log("INFO", "datanotes left a note that changed meanwhile as it is", { path: r.path, error: messageOf(e) });
        }
      };
      const all = () => eachLimit(plan, MOVE_WRITES, write);
      await (plan.length >= BULK_FROM ? bulkWrite(app, all) : all());
      if (written.length === 0) return null;
      written.sort((a, b) => a.path.localeCompare(b.path));
      const paths = written.map((r) => r.path);
      invalidateFiles(app, paths);
      const list = [...moved].map(([from, to]) => ({ from, to }));
      const summary = `repair the links after the hand move of ${described(list)}`;
      const journal = await writeJournal(
        app,
        settings,
        { op: "repair_links", summary, executed_at: now.toISOString(), rows: [], creates: [], moves: [], references: written, deleted: [], failed: [] },
        now,
      );
      await logEngineWrite(app, settings, { operation: "REPAIR LINKS", parameters: { moves: list }, migrationId: journal.id, touched: paths, now });
      notifyApplied(app, { op: "repair_links", summary, migrationId: journal.id, paths, moves: [], deletes: [], handMoves: list });
      telemetry().log("INFO", "datanotes repaired links after a hand move", { moves: list.length, notes: paths.length, migration_id: journal.id });
      return { migrationId: journal.id, paths, moves: list };
    }),
  );
}

/** Why the vault is busy for a repair right now (a git pull under way), or null. */
export type RepairGate = () => string | null;

const GATES = new WeakMap<object, RepairGate>();

/**
 * Register (or with null remove) the host's way to say the vault is busy: while it gives a reason
 * (git pulling, a rebase or a merge in progress), hand-move repairs wait.
 */
export function setRepairGate(app: App, gate: RepairGate | null): void {
  if (gate) GATES.set(app, gate);
  else GATES.delete(app);
}

function busyReason(app: App): string | null {
  try {
    return GATES.get(app)?.() ?? null;
  } catch (e) {
    return messageOf(e); // a gate that cannot tell: wait, as when busy
  }
}

/** Moves seen in one batch of hand edits, with the notes whose links then still reached an old path. */
interface Queued {
  moves: HandMove[];
  /** Note path → its text when the moves were seen (notes the batch itself did not change). */
  linkers: Map<string, string>;
}

/**
 * The hand moves waiting for their link repair: run once the vault is quiet (no vault event for
 * {@link HAND_MOVE_TIMING}`.quietMs`) and not busy ({@link setRepairGate}), as one operation for
 * every move seen meanwhile. A vault event while the repair plans throws the plan away: it is made
 * again after the next quiet time.
 */
export class HandMoveRepairs {
  private queued: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Vault events seen (a plan made before the last one is stale). */
  private events = 0;
  private running: Promise<void> | null = null;
  private stopped = false;
  private waiting: string | null = null;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => DatanotesSettings,
  ) {}

  /** Whether moves wait for their repair. */
  get pending(): boolean {
    return this.queued.length > 0;
  }

  /**
   * Moves seen in a batch of hand edits. `changed`: the notes the batch created or edited, whose
   * links may be new (a link to an old path that holds another file again is then left alone).
   */
  async add(moves: readonly HandMove[], changed: ReadonlySet<string>): Promise<boolean> {
    const linksAfterMove = this.app.fileManager.linksAfterMove?.bind(this.app.fileManager);
    if (this.stopped || moves.length === 0 || !linksAfterMove || !this.getSettings().repairLinksOnHandMove) return false;
    // which notes link to an old path now: their links were written before the move (a → b, then c → a)
    const linkers = new Map<string, string>();
    try {
      for (const r of await linksAfterMove(netMoves(moves), { reoccupied: () => true })) if (!changed.has(r.path)) linkers.set(r.path, r.before);
    } catch (e) {
      telemetry().log("WARN", "datanotes could not read the links after a hand move", { moves: moves.length, error: messageOf(e) });
    }
    this.queued.push({ moves: [...moves], linkers });
    this.schedule();
    return true;
  }

  /** A vault event: the vault is not quiet yet. */
  activity(): void {
    this.events++;
    if (this.queued.length > 0) this.schedule();
  }

  private schedule(wait = HAND_MOVE_TIMING.quietMs): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, wait);
  }

  /** Repair now what waits (tests, shutdown), unless the vault is busy. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.run();
  }

  /** Stop: what waits is repaired now, or, while the vault is busy, left (logged). */
  async stop(): Promise<void> {
    await this.flush();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queued.length > 0) {
      const moves = this.queued.flatMap((q) => q.moves);
      telemetry().log("WARN", "datanotes did not repair the links after a hand move: the vault was busy when it stopped", { moves: moves.length, first: `${moves[0]!.from} to ${moves[0]!.to}` });
      this.queued = [];
    }
  }

  private run(): Promise<void> {
    this.running ??= this.repair().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async repair(): Promise<void> {
    if (this.queued.length === 0) return;
    const busy = busyReason(this.app);
    if (busy) {
      if (this.waiting !== busy) telemetry().log("INFO", "datanotes waits to repair the links after a hand move", { reason: busy });
      this.waiting = busy;
      this.schedule(HAND_MOVE_TIMING.retryMs);
      return;
    }
    this.waiting = null;
    const queued = this.queued;
    this.queued = [];
    const texts = new Map<string, Set<string>>();
    for (const q of queued) for (const [p, t] of q.linkers) texts.set(p, (texts.get(p) ?? new Set()).add(t));
    const seen = this.events;
    let stale = false;
    try {
      await repairHandMoves(
        this.app,
        this.getSettings(),
        queued.flatMap((q) => q.moves),
        new Date(),
        {
          // a link to an old path that holds another file again meant the moved file only in a note
          // unchanged since the move was seen
          reoccupied: (_from, note, text) => texts.get(note)?.has(text) === true,
          beforeWrite: () => {
            stale = this.events !== seen || busyReason(this.app) !== null;
            return !stale;
          },
        },
      );
    } catch (e) {
      telemetry().log("WARN", "datanotes could not repair the links after a hand move", { moves: queued.reduce((n, q) => n + q.moves.length, 0), error: messageOf(e) });
    }
    if (stale) {
      // planned while the vault changed: planned again after the next quiet time
      this.queued = [...queued, ...this.queued];
      this.schedule();
    }
  }
}

/** Where the row paths are saved by id (moves made while the engine was stopped). */
const ROW_PATHS = storePath("hand-moves", "rows.json");

/** Save where each row is, by id: a row found elsewhere at the next start was moved by hand meanwhile. */
export async function saveRowPaths(app: App, rows: ReadonlyMap<string, string>): Promise<void> {
  await storeWrite(app, ROW_PATHS, JSON.stringify(Object.fromEntries([...rows].sort(([a], [b]) => a.localeCompare(b)))));
}

/**
 * The rows at another path than the one saved by {@link saveRowPaths} (by id): moved by hand while
 * the engine was stopped. A saved path that holds a file again is left out (the row's links to it
 * are ambiguous). Empty when nothing was saved yet.
 */
export async function rowMovesSince(app: App, rows: ReadonlyMap<string, string>): Promise<HandMove[]> {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse((await storeRead(app, ROW_PATHS)) ?? "{}") as Record<string, unknown>;
  } catch (e) {
    telemetry().log("WARN", "datanotes could not read the saved row paths", { error: messageOf(e) });
    return [];
  }
  const out: HandMove[] = [];
  for (const [id, to] of rows) {
    const from = saved[id];
    if (typeof from === "string" && from !== to && !app.vault.getAbstractFileByPath(from)) out.push({ from, to });
  }
  return out.sort((a, b) => a.to.localeCompare(b.to));
}
