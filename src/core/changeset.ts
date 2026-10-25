/**
 * Change sets: the write side of table operations (phase 33).
 *
 * An operation computes a {@link ChangeSet} (row/schema frontmatter edits, file creations,
 * moves, reference rewrites) without touching the vault. {@link applyChangeSet} writes it,
 * stops at the first failure, and always journals what was applied so {@link undoMigration}
 * can revert it.
 */

import type { App, TFile } from "./host";
import {
  buildMarkdownWithFrontmatter,
  fmDelete,
  fmReorder,
  fmSet,
  readOrderedFromMarkdown,
  splitFrontmatter,
  writeFrontmatter,
} from "./frontmatter";
import type { DatanotesSettings } from "./settings";
import { currentActor, type Actor } from "./actor";
import { markUndone, readJournal, writeJournal } from "./journal";
import { isStorePath, storeExists, storeList, storeRename } from "./store";
import { metastorePath, withNewDatabaseConfig } from "./metastore";
import { withMetastoreId } from "./database-id";
import type { OrderedFrontmatter } from "./types";
import { messageOf } from "./message";
import { contentHash, readHashed } from "./file-cache";
import { phase } from "./tracing";

/**
 * The hash a journal keeps of a note it created (`created_hashes`): of its front matter values,
 * in order, and its body, so a note written back to the same values in another YAML style still
 * counts as unchanged; of the whole text when the front matter cannot be read.
 */
export function createdHash(text: string): string {
  try {
    const { ordered, body } = readOrderedFromMarkdown(text);
    return contentHash(JSON.stringify([ordered, body]));
  } catch {
    return contentHash(text);
  }
}

/** Frontmatter edit on one note. */
export interface NoteEdit {
  path: string;
  before: OrderedFrontmatter;
  after: OrderedFrontmatter;
  /** Body replacement: `bodyAfter` is written only if the current body still equals `bodyBefore`. */
  bodyBefore?: string;
  bodyAfter?: string;
}

function bodyChanges(e: { bodyBefore?: string; bodyAfter?: string }): boolean {
  return e.bodyAfter !== undefined && e.bodyAfter !== e.bodyBefore;
}

/** Markdown body after the frontmatter block (the whole text when there is none). */
export function bodyOf(text: string): string {
  const split = splitFrontmatter(text);
  return split ? split.body : text;
}

/** Replace the body, keeping the frontmatter block byte-for-byte. */
export function replaceBody(text: string, body: string): string {
  const split = splitFrontmatter(text);
  if (!split) return body;
  return text.slice(0, text.length - split.body.length) + body;
}

async function writeBody(app: App, file: TFile, expected: string, next: string): Promise<void> {
  await app.vault.process(file, (text) => {
    if (bodyOf(text) !== expected) throw new Error("note body changed since it was read");
    return replaceBody(text, next);
  });
}

export interface FileCreate {
  path: string;
  content: string;
}

export interface FileMove {
  from: string;
  to: string;
}

/**
 * Rows going into a pack (`pack`) or coming out of it (`unpack`), through the host (`App.packs`):
 * silent for the rows (same paths, texts and stats), journaled so undo can do the opposite.
 */
export interface PackChange {
  action: "pack" | "unpack";
  table: string;
  key: string;
  /** The pack's file. */
  pack: string;
  /** The rows' paths. */
  rows: string[];
  /** The property that names a row's table (the setting `tableKey`). */
  tableKey: string;
}

export interface ChangeSet {
  op: string;
  schema?: string;
  summary: string;
  edits: NoteEdit[];
  creates: FileCreate[];
  moves: FileMove[];
  /** Files sent to the trash; their content is journaled so undo can recreate them. */
  deletes: string[];
  /**
   * Whole-text rewrites of non-note files (the metastore, `metastore.yaml`): `before` must still be
   * the current text; `before: ""` on a missing file creates it. Journaled as text references.
   */
  texts: { path: string; before: string; after: string }[];
  /** Set when the change set already holds its inverse-link edits (no second pass). */
  skipInverse?: boolean;
  /** Rows going into packs or coming out (after the texts). */
  packs?: PackChange[];
}

export function emptyChangeSet(op: string, summary: string, schema?: string): ChangeSet {
  return {
    op,
    summary,
    ...(schema !== undefined ? { schema } : {}),
    edits: [],
    creates: [],
    moves: [],
    deletes: [],
    texts: [],
  };
}

/** Keys whose value or presence differs between `before` and `after`. */
export interface EditDiff {
  set: [string, unknown][];
  remove: string[];
  beforeValues: Record<string, unknown>;
  beforeAbsent: string[];
  afterValues: Record<string, unknown>;
  afterAbsent: string[];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffOrdered(before: OrderedFrontmatter, after: OrderedFrontmatter): EditDiff {
  const b = new Map(before);
  const a = new Map(after);
  const d: EditDiff = {
    set: [],
    remove: [],
    beforeValues: {},
    beforeAbsent: [],
    afterValues: {},
    afterAbsent: [],
  };
  const keys = new Set([...b.keys(), ...a.keys()]);
  for (const k of keys) {
    const inB = b.has(k);
    const inA = a.has(k);
    if (inB && inA && same(b.get(k), a.get(k))) continue;
    if (inB) d.beforeValues[k] = b.get(k);
    else d.beforeAbsent.push(k);
    if (inA) {
      d.afterValues[k] = a.get(k);
      d.set.push([k, a.get(k)]);
    } else {
      d.afterAbsent.push(k);
      d.remove.push(k);
    }
  }
  return d;
}

export function editIsNoop(e: NoteEdit): boolean {
  const d = diffOrdered(e.before, e.after);
  const orderChanged = !same(
    e.before.map(([k]) => k),
    e.after.map(([k]) => k),
  );
  return d.set.length === 0 && d.remove.length === 0 && !orderChanged && !bodyChanges(e);
}

/** Apply only the changed keys onto `current`, then align key order with `order`. */
export function applyDiff(
  current: OrderedFrontmatter,
  set: readonly [string, unknown][],
  remove: readonly string[],
  order: readonly string[],
): OrderedFrontmatter {
  let out = current;
  for (const k of remove) out = fmDelete(out, k);
  for (const [k, v] of set) out = fmSet(out, k, v);
  return fmReorder(out, order);
}

// --- Journal ---

export interface JournalRow {
  path: string;
  before: Record<string, unknown>;
  before_absent: string[];
  before_order: string[];
  after: Record<string, unknown>;
  after_absent: string[];
  body_before?: string;
  body_after?: string;
}

export interface JournalReference {
  path: string;
  before_text: string;
  after_text: string;
}

export interface JournalEntry {
  migration_id: string;
  op: string;
  schema?: string;
  summary: string;
  executed_at: string;
  rows: JournalRow[];
  creates: string[];
  /**
   * Of the notes in `creates`, the hash of each as the operation left it ({@link createdHash}): its
   * undo trashes a note only while it still has that content. Absent in entries written before it.
   */
  created_hashes?: { path: string; hash: string }[];
  moves: FileMove[];
  references: JournalReference[];
  /** Notes the operation deleted (restored by its undo): the engine always writes it, empty when none. */
  deleted?: { path: string; content: string }[];
  failed: { path: string; error: string }[];
  undoes?: string;
  /** For `op: "batch"`: the operations of the batch, in the order they ran. */
  members?: string[];
  /** The agent that ran the operation (MCP session, harness, model, tool); absent for commands. */
  actor?: Actor;
  /** Rows the operation put into packs or took out (pack_rows, unpack_rows), in order: undo does the opposite. */
  packs?: PackChange[];
}

export interface ApplyResult {
  ok: boolean;
  migrationId: string;
  journalPath: string;
  notesChanged: number;
  filesCreated: number;
  filesMoved: number;
  filesDeleted: number;
  referencesUpdated: number;
  failed: { path: string; error: string }[];
}

export function fileOrNull(app: App, path: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(path);
  return f != null && "extension" in f ? (f as TFile) : null;
}

export function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
  if (folder === "") return;
  if (app.vault.getAbstractFileByPath(folder) != null) return;
  await ensureFolder(app, parentFolder(folder));
  await app.vault.createFolder(folder);
}

export { MigrationNotFoundError, readJournal } from "./journal";

// --- Apply ---

async function readOrderedFor(app: App, file: TFile): Promise<OrderedFrontmatter> {
  return readOrderedFromMarkdown(await app.vault.read(file)).ordered;
}

/** A file of the engine's store (`store:…`): not in the vault, read through the store. */
const inStore = isStorePath;

/** Whether a file is at `path` (a store file or a note). */
async function fileExists(app: App, path: string): Promise<boolean> {
  return inStore(path) ? storeExists(app, path) : fileOrNull(app, path) != null;
}

/** Whether anything (a file, a folder, a store file) is at `path`. */
async function occupied(app: App, path: string): Promise<boolean> {
  return inStore(path) ? storeExists(app, path) : app.vault.getAbstractFileByPath(path) != null;
}

/**
 * The store files written since the operation into a store folder it moved files to: they go back
 * with the moved ones. A transaction log follows its renamed table file by file, and the commits
 * made under the new name (the rename's own included) are its history too, so undoing the rename
 * takes the whole log back.
 */
async function storeFilesSince(app: App, moves: readonly FileMove[]): Promise<FileMove[]> {
  const folders = new Map<string, string>();
  for (const m of moves) if (inStore(m.from) && inStore(m.to)) folders.set(parentFolder(m.to), parentFolder(m.from));
  const moved = new Set(moves.map((m) => m.to));
  const out: FileMove[] = [];
  for (const [to, from] of folders) {
    for (const f of (await storeList(app, to)).files) {
      if (!moved.has(f)) out.push({ from: `${from}/${f.slice(to.length + 1)}`, to: f });
    }
  }
  return out;
}

/**
 * Bulk writes: a change set creating or editing at least `from` notes writes `atOnce` of them at
 * a time (a smaller one writes one at a time, in order).
 */
export const WRITE_CONCURRENCY = { atOnce: 16, from: 32 };

/** How many of `count` notes a write creates or edits at a time. */
function atOnceFor(count: number): number {
  return count >= WRITE_CONCURRENCY.from ? WRITE_CONCURRENCY.atOnce : 1;
}

/** A write of one note done, and how to take it back. */
interface Written<R> {
  value: R;
  undo(): Promise<void>;
}

/**
 * Run `fn` on `items`, `limit` at a time, in their order: once one fails no other starts (those
 * under way end). What it leaves is what one at a time leaves: the items before the first that
 * failed written, that failure, nothing after it; the items after it that were under way and
 * succeeded are taken back (`undo`, newest first). One that cannot be taken back stays written
 * and is returned with the others, so the journal names everything written.
 */
async function inOrder<T, R>(
  items: readonly T[],
  pathOf: (item: T) => string,
  fn: (item: T) => Promise<Written<R>>,
  limit = atOnceFor(items.length),
): Promise<{ done: R[]; failed: { path: string; error: string } | null }> {
  const results: ({ ok: true; written: Written<R> } | { ok: false; error: string } | undefined)[] = new Array(items.length);
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, written: await fn(items[i]!) };
      } catch (e) {
        results[i] = { ok: false, error: messageOf(e) };
        stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  const first = results.findIndex((r) => r !== undefined && !r.ok);
  const kept = new Set<number>();
  if (first >= 0) {
    for (let i = results.length - 1; i > first; i--) {
      const r = results[i];
      if (!r?.ok) continue;
      try {
        await r.written.undo();
      } catch {
        kept.add(i); // still written: the journal names it, the rollback takes it back
      }
    }
  }
  const done: R[] = [];
  results.forEach((r, i) => {
    if (r?.ok && (first < 0 || i < first || kept.has(i))) done.push(r.written.value);
  });
  const f = first >= 0 ? (results[first] as { error: string }) : null;
  return { done, failed: f ? { path: pathOf(items[first]!), error: f.error } : null };
}

/** Put rows into a pack, or take them out, through the host. */
async function applyPack(app: App, p: PackChange): Promise<void> {
  if (!app.packs) throw new Error("this host keeps no packs of rows");
  if (p.action === "pack") await app.packs.pack({ table: p.table, key: p.key, path: p.pack, rows: p.rows, tableKey: p.tableKey });
  else await app.packs.unpack(p.pack, p.rows);
}

/** The opposite of a pack change (undo). */
function oppositePack(p: PackChange): PackChange {
  return { ...p, action: p.action === "pack" ? "unpack" : "pack" };
}

async function moveFile(app: App, from: string, to: string): Promise<void> {
  // Files of the engine's store (e.g. a transaction log following a renamed table).
  if (inStore(from)) return storeRename(app, from, to);
  const f = fileOrNull(app, from);
  if (!f) throw new Error(`file not found: ${from}`);
  if (app.vault.getAbstractFileByPath(to) != null) throw new Error(`target exists: ${to}`);
  await ensureFolder(app, parentFolder(to));
  await app.fileManager.renameFile(f, to);
}

/**
 * Write a change set. Order: creates → frontmatter edits → reference rewrites → moves.
 * Stops at the first failure; the journal records exactly what was applied.
 */
async function applyChangeSetImpl(
  app: App,
  settings: DatanotesSettings,
  cs: ChangeSet,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const rows: JournalRow[] = [];
  const creates: string[] = [];
  const moves: FileMove[] = [];
  const references: JournalReference[] = [];
  const deleted: { path: string; content: string }[] = [];
  const failed: { path: string; error: string }[] = [];
  const packs: PackChange[] = [];
  let referencesUpdated = 0;

  const fail = (path: string, e: unknown) => {
    failed.push({ path, error: messageOf(e) });
  };

  run: {
    // notes created several at a time (each folder made once); they stop at the first failure
    const folders = new Map<string, Promise<void>>();
    const folderOnce = (folder: string): Promise<void> => {
      if (folder === "") return Promise.resolve();
      let p = folders.get(folder);
      if (!p) {
        p = folderOnce(parentFolder(folder)).then(async () => {
          if (app.vault.getAbstractFileByPath(folder) == null) await app.vault.createFolder(folder);
        });
        folders.set(folder, p);
      }
      return p;
    };
    const created = await inOrder(cs.creates, (c) => c.path, async (c) => {
      if (app.vault.getAbstractFileByPath(c.path) != null) throw new Error(`file exists: ${c.path}`);
      await folderOnce(parentFolder(c.path));
      const file = await app.vault.create(c.path, c.content);
      return { value: c.path, undo: () => app.vault.delete(file, true) };
    });
    creates.push(...created.done);
    if (created.failed) {
      failed.push(created.failed);
      break run;
    }
    for (const t of cs.texts) {
      try {
        const existing = app.vault.getAbstractFileByPath(t.path);
        if (existing == null) {
          if (t.before !== "") throw new Error("file not found");
          // the engine creates the database: its metastore gets the settings of a new database and its id
          if (t.path === metastorePath(settings)) {
            t.after = withNewDatabaseConfig(t.after);
            if (settings.databaseId) t.after = withMetastoreId(t.after, settings.databaseId);
          }
          await ensureFolder(app, parentFolder(t.path));
          await app.vault.create(t.path, t.after);
        } else {
          await app.vault.process(existing as TFile, (current) => {
            if (current !== t.before) throw new Error("file changed since it was read");
            return t.after;
          });
        }
        references.push({ path: t.path, before_text: t.before, after_text: t.after });
      } catch (err) {
        fail(t.path, err);
        break run;
      }
    }
    for (const p of cs.packs ?? []) {
      try {
        await applyPack(app, p);
        packs.push(p);
      } catch (err) {
        fail(p.pack, err);
        break run;
      }
    }
    // notes edited several at a time when no note is edited twice (each is read, changed and
    // written on its own); journaled in the order of the change set, up to the first failure
    const edits = cs.edits.filter((e) => !editIsNoop(e));
    const distinct = new Set(edits.map((e) => e.path)).size === edits.length;
    const atOnce = distinct ? atOnceFor(edits.length) : 1;
    const edited = await inOrder(edits, (e) => e.path, async (e): Promise<Written<JournalRow>> => {
      const file = fileOrNull(app, e.path);
      if (!file) throw new Error("file not found");
      // the text before, to take the edit back when an earlier one fails (only when several run at once)
      const was = atOnce > 1 ? (await readHashed(app, file)).content : "";
      const d = diffOrdered(e.before, e.after);
      const order = e.after.map(([k]) => k);
      const fmChanged =
        d.set.length > 0 || d.remove.length > 0 || !same(e.before.map(([k]) => k), order);
      if (fmChanged) {
        await writeFrontmatter(app, file, (fm) => applyDiff(fm, d.set, d.remove, order));
      }
      if (bodyChanges(e)) await writeBody(app, file, e.bodyBefore!, e.bodyAfter!);
      const row: JournalRow = {
        path: e.path,
        before: d.beforeValues,
        before_absent: d.beforeAbsent,
        before_order: e.before.map(([k]) => k),
        after: d.afterValues,
        after_absent: d.afterAbsent,
        ...(bodyChanges(e) ? { body_before: e.bodyBefore!, body_after: e.bodyAfter! } : {}),
      };
      return { value: row, undo: async () => void (await app.vault.process(file, () => was)) };
    }, atOnce);
    rows.push(...edited.done);
    if (edited.failed) {
      failed.push(edited.failed);
      break run;
    }
    for (const m of cs.moves) {
      try {
        await moveFile(app, m.from, m.to);
        moves.push(m);
      } catch (err) {
        fail(m.from, err);
        break run;
      }
    }
    for (const p of cs.deletes) {
      const file = fileOrNull(app, p);
      try {
        if (!file) throw new Error("file not found");
        const content = await app.vault.read(file);
        await trash(app, file);
        deleted.push({ path: p, content });
      } catch (err) {
        fail(p, err);
        break run;
      }
    }
  }

  // the notes created, as the operation leaves them (after its own edits and moves): an undo
  // trashes one only while it is unchanged
  const createdHashes: { path: string; hash: string }[] = [];
  const movedTo = new Map(moves.map((m) => [m.from, m.to]));
  for (const p of creates) {
    const f = fileOrNull(app, movedTo.get(p) ?? p);
    if (!f) continue;
    try {
      createdHashes.push({ path: p, hash: createdHash(await app.vault.read(f)) });
    } catch {
      // a read refused now: its undo checks only that the note is still there
    }
  }

  const journal = await writeJournal(
    app,
    settings,
    {
      op: cs.op,
      ...(cs.schema !== undefined ? { schema: cs.schema } : {}),
      ...(currentActor() ? { actor: currentActor() } : {}),
      summary: cs.summary,
      executed_at: now.toISOString(),
      rows,
      creates,
      ...(createdHashes.length > 0 ? { created_hashes: createdHashes } : {}),
      moves,
      references,
      deleted,
      failed,
      ...(packs.length > 0 ? { packs } : {}),
    },
    now,
  );

  return {
    ok: failed.length === 0,
    migrationId: journal.id,
    journalPath: journal.path,
    notesChanged: rows.length,
    filesCreated: creates.length,
    filesMoved: moves.length,
    filesDeleted: deleted.length,
    referencesUpdated,
    failed,
  };
}

// --- Undo ---

export interface UndoConflict {
  path: string;
  message: string;
}

export interface UndoResult {
  ok: boolean;
  undoes: string;
  migration_id?: string;
  conflicts: UndoConflict[];
  failed: { path: string; error: string }[];
  /** Paths the undo wrote (for the transaction log). */
  touched?: string[];
  /** When the undo failed: the files it did not put back (the one that failed first). */
  left?: string[];
}

export async function trash(app: App, file: TFile): Promise<void> {
  const fm = app.fileManager as unknown as { trashFile?: (f: TFile) => Promise<void> };
  if (typeof fm.trashFile === "function") {
    await fm.trashFile(file);
  } else {
    await app.vault.trash(file, true);
  }
}

/**
 * The writes undoing `entries` (newest first: the members of a batch, or one operation) make, as
 * one change set from the vault as it is to the state they leave (for checks; never applied): rows
 * get their values back, moves go back, created files go, deleted ones come back, and other texts
 * (the metastore) get their old text back, in `texts`. Each entry is undone on the state the ones
 * before it leave, so a batch is checked on its final state, not step by step.
 */
export async function undoChangeSet(app: App, entries: readonly JournalEntry[], summary = `undo ${entries.map((e) => e.migration_id).join(", ")}`): Promise<ChangeSet> {
  type Note = { ordered: OrderedFrontmatter; body: string } | null;
  const state = new Map<string, Note>();
  const texts = new Map<string, { before: string; after: string }>();
  /** Where a path's file was in the vault before the undo (moved files). */
  const origin = new Map<string, string>();
  const vaultNote = async (path: string): Promise<Note> => {
    const f = fileOrNull(app, path);
    if (!f) return null;
    const text = await app.vault.read(f);
    return { ordered: readOrderedFromMarkdown(text).ordered, body: bodyOf(text) };
  };
  const read = async (path: string): Promise<Note> => (state.has(path) ? state.get(path)! : vaultNote(path));
  for (const entry of entries) {
    const movedTo = new Map(entry.moves.map((m) => [m.from, m.to]));
    const currentPath = (p: string) => movedTo.get(p) ?? p;
    for (const ref of entry.references) {
      const path = currentPath(ref.path);
      if (/\.md$/i.test(path)) {
        const { ordered } = readOrderedFromMarkdown(ref.before_text);
        state.set(path, { ordered, body: bodyOf(ref.before_text) });
      } else {
        texts.set(path, { before: texts.get(path)?.before ?? ref.after_text, after: ref.before_text });
      }
    }
    for (const r of entry.rows) {
      const path = currentPath(r.path);
      const cur = await read(path);
      if (!cur) continue;
      state.set(path, { ...cur, ordered: applyDiff(cur.ordered, Object.entries(r.before), r.before_absent, r.before_order) });
    }
    for (const m of [...entry.moves].reverse()) {
      state.set(m.from, await read(m.to));
      state.set(m.to, null);
      origin.set(m.from, origin.get(m.to) ?? m.to);
      origin.delete(m.to);
    }
    for (const c of entry.creates) state.set(c, null);
    for (const d of entry.deleted!) state.set(d.path, { ordered: readOrderedFromMarkdown(d.content).ordered, body: bodyOf(d.content) });
  }
  const cs = emptyChangeSet("undo_migration", summary);
  const moved = new Set<string>();
  for (const [to, from] of origin) {
    const final = state.get(to);
    if (to === from || !final || !fileOrNull(app, from)) continue;
    moved.add(to).add(from);
    cs.moves.push({ from, to });
    cs.edits.push({ path: from, before: (await vaultNote(from))!.ordered, after: final.ordered });
  }
  for (const [path, final] of state) {
    if (moved.has(path)) continue;
    const now = fileOrNull(app, path) ? await vaultNote(path) : null;
    if (now && final) cs.edits.push({ path, before: now.ordered, after: final.ordered });
    else if (now) cs.deletes.push(path);
    else if (final) cs.creates.push({ path, content: buildMarkdownWithFrontmatter(final.ordered, final.body) });
  }
  for (const [path, t] of texts) if (t.before !== t.after) cs.texts.push({ path, ...t });
  return cs;
}

/**
 * Journal entries that record what happened to the database without undo data, and why undo
 * refuses them.
 */
export const RECORD_ONLY_OPS: Readonly<Record<string, string>> = {
  move_database: "a move of the database folder cannot be undone: move it back with configure_database (root)",
  set_database_id: "the database's id cannot be taken back: the engine finds its store by it",
  rollback: "the rollback of a failed write cannot be undone: it put the database back as it was; run the write again instead",
};

/**
 * Revert a journaled operation. Refuses (no writes) when any touched note changed since:
 * every conflict is reported so the caller can decide. `check` (the engine's CHECKs that follow
 * links) is given the undo's writes once nothing changed since: the conflicts it returns refuse it.
 * The undo is journaled with everything it wrote (row values and order, moves, the metastore's
 * text, the files it removed with their content, the files it put back), so undoing an undo is a
 * redo, whatever the operation.
 *
 * An operation that failed partway (its entry lists `failed`) may be partly put back already, by a
 * rollback that failed in its turn: what is already as it was before the operation is left as it
 * is, so the undo can be retried. `op: "rollback"` journals the undo as the engine's rollback of a
 * failed write (which cannot be undone in its turn). When the undo fails, `left` names the files
 * it did not put back.
 */
export async function undoMigration(
  app: App,
  settings: DatanotesSettings,
  migrationId: string,
  now: Date = new Date(),
  check?: (cs: ChangeSet) => Promise<UndoConflict[]>,
  op: "undo_migration" | "rollback" = "undo_migration",
): Promise<UndoResult> {
  const { entry, path: journalPath, undone } = await readJournal(app, settings, migrationId);
  const conflicts: UndoConflict[] = [];
  /** A failed operation: what is already back as before it is skipped (a retried rollback). */
  const partial = entry.failed.length > 0;
  const back = new Set<unknown>();
  const why = RECORD_ONLY_OPS[entry.op];
  if (why) return { ok: false, undoes: migrationId, conflicts: [{ path: journalPath, message: why }], failed: [] };
  if (undone) {
    return {
      ok: false,
      undoes: migrationId,
      conflicts: [{ path: journalPath, message: "migration already undone" }],
      failed: [],
    };
  }

  // 1. Verify: nothing changed since the operation.
  const movedTo = new Map(entry.moves.map((m) => [m.from, m.to]));
  const currentPath = (p: string) => movedTo.get(p) ?? p;
  for (const r of entry.rows) {
    const f = fileOrNull(app, currentPath(r.path));
    if (!f) {
      conflicts.push({ path: r.path, message: "note no longer exists" });
      continue;
    }
    const cur = new Map(await readOrderedFor(app, f));
    if (
      partial &&
      Object.entries(r.before).every(([k, v]) => cur.has(k) && same(cur.get(k), v)) &&
      r.before_absent.every((k) => !cur.has(k)) &&
      (r.body_before === undefined || bodyOf(await app.vault.read(f)) === r.body_before)
    ) {
      back.add(r);
      continue;
    }
    for (const [k, v] of Object.entries(r.after)) {
      if (!cur.has(k) || !same(cur.get(k), v)) {
        conflicts.push({ path: r.path, message: `"${k}" changed since the operation` });
      }
    }
    for (const k of r.after_absent) {
      if (cur.has(k)) conflicts.push({ path: r.path, message: `"${k}" was added since the operation` });
    }
    if (r.body_after !== undefined && bodyOf(await app.vault.read(f)) !== r.body_after) {
      conflicts.push({ path: r.path, message: "body changed since the operation" });
    }
  }
  for (const ref of entry.references) {
    const f = fileOrNull(app, currentPath(ref.path));
    const text = f ? await app.vault.read(f) : null;
    if (partial && text === ref.before_text) back.add(ref);
    else if (text !== ref.after_text) {
      conflicts.push({ path: ref.path, message: "text changed since the operation" });
    }
  }
  const since = await storeFilesSince(app, entry.moves);
  /** Store files gone since (old versions vacuum_table removed): nothing to move back. */
  const vacuumed = new Set<string>();
  for (const m of entry.moves) {
    if (!(await fileExists(app, m.to))) {
      if (inStore(m.to)) vacuumed.add(m.to);
      else if (partial && (await fileExists(app, m.from))) back.add(m);
      else conflicts.push({ path: m.to, message: "moved file no longer exists" });
    } else if (await occupied(app, m.from)) {
      conflicts.push({ path: m.from, message: "original path is occupied" });
    }
  }
  for (const m of since) {
    if (await occupied(app, m.from)) conflicts.push({ path: m.from, message: "original path is occupied" });
  }
  // rows put into packs are still there; rows taken out are notes of their own still
  for (const p of entry.packs ?? []) {
    const where = p.rows.map((r) => app.packs?.locate(r)?.pack ?? null);
    if (p.action === "pack") {
      if (where.every((w) => w === p.pack)) continue;
      if (partial && where.every((w, i) => w === null && fileOrNull(app, p.rows[i]!))) {
        back.add(p);
        continue;
      }
      p.rows.forEach((r, i) => where[i] !== p.pack && conflicts.push({ path: r, message: `row no longer in the pack ${p.pack}` }));
    } else {
      if (where.every((w, i) => w === null && fileOrNull(app, p.rows[i]!))) continue;
      if (partial && where.every((w) => w === p.pack)) {
        back.add(p);
        continue;
      }
      p.rows.forEach((r, i) => (where[i] !== null || !fileOrNull(app, r)) && conflicts.push({ path: r, message: where[i] !== null ? `row went into the pack ${where[i]} since the operation` : "note no longer exists" }));
    }
  }
  const hashOfCreated = new Map((entry.created_hashes ?? []).map((h) => [h.path, h.hash]));
  for (const c of entry.creates) {
    const f = fileOrNull(app, currentPath(c));
    if (f) {
      // a note changed since it was created is not trashed (an entry written before the hashes were kept: not compared)
      const was = hashOfCreated.get(c);
      if (!partial && was !== undefined && createdHash(await app.vault.read(f)) !== was) {
        conflicts.push({ path: currentPath(c), message: "created note changed since the operation" });
      }
      continue;
    }
    if (partial) back.add(c);
    else conflicts.push({ path: c, message: "created file no longer exists" });
  }
  for (const d of entry.deleted!) {
    const f = fileOrNull(app, d.path);
    if (partial && f && (await app.vault.read(f)) === d.content) back.add(d);
    else if (app.vault.getAbstractFileByPath(d.path) != null) {
      conflicts.push({ path: d.path, message: "deleted path is occupied" });
    }
  }
  if (conflicts.length > 0) return { ok: false, undoes: migrationId, conflicts, failed: [] };
  if (check) {
    const refused = await check(await undoChangeSet(app, [entry], `undo ${migrationId}`));
    if (refused.length > 0) return { ok: false, undoes: migrationId, conflicts: refused, failed: [] };
  }

  // 2. Revert: references, frontmatter, moves (reverse), creates.
  const failed: { path: string; error: string }[] = [];
  const undoRows: JournalRow[] = [];
  const undoMoves: FileMove[] = [];
  const undoReferences: JournalReference[] = [];
  const undoCreates: string[] = [];
  const undoCreatedHashes: { path: string; hash: string }[] = [];
  const undoDeleted: { path: string; content: string }[] = [];
  const undoPacks: PackChange[] = [];
  /** The writes of the undo, in order, each with the file it puts back. */
  const steps: { path: string; run: () => Promise<void> }[] = [];
  // the packs first (they were written after the texts), newest first
  for (const p of [...(entry.packs ?? [])].reverse()) {
    if (back.has(p)) continue;
    steps.push({
      path: p.pack,
      run: async () => {
        const o = oppositePack(p);
        await applyPack(app, o);
        undoPacks.push(o);
      },
    });
  }
  for (const ref of entry.references) {
    if (back.has(ref)) continue;
    steps.push({
      path: currentPath(ref.path),
      run: async () => {
        const f = fileOrNull(app, currentPath(ref.path))!;
        await app.vault.process(f, () => ref.before_text);
        undoReferences.push({ path: currentPath(ref.path), before_text: ref.after_text, after_text: ref.before_text });
      },
    });
  }
  for (const r of entry.rows) {
    if (back.has(r)) continue;
    steps.push({
      path: currentPath(r.path),
      run: async () => {
        const f = fileOrNull(app, currentPath(r.path))!;
        const order = (await readOrderedFor(app, f)).map(([k]) => k);
        if (Object.keys(r.after).length > 0 || r.after_absent.length > 0 || Object.keys(r.before).length > 0) {
          await writeFrontmatter(app, f, (fm) =>
            applyDiff(fm, Object.entries(r.before), r.before_absent, r.before_order),
          );
        }
        if (r.body_after !== undefined) await writeBody(app, f, r.body_after, r.body_before!);
        undoRows.push({
          path: currentPath(r.path),
          before: r.after,
          before_absent: r.after_absent,
          before_order: order,
          after: r.before,
          after_absent: r.before_absent,
          ...(r.body_after !== undefined ? { body_before: r.body_after, body_after: r.body_before! } : {}),
        });
      },
    });
  }
  for (const m of [...[...entry.moves].reverse().filter((x) => !vacuumed.has(x.to) && !back.has(x)), ...since]) {
    steps.push({
      path: m.to,
      run: async () => {
        await moveFile(app, m.to, m.from);
        undoMoves.push({ from: m.to, to: m.from });
      },
    });
  }
  for (const c of entry.creates) {
    if (back.has(c)) continue;
    steps.push({
      path: c,
      run: async () => {
        const f = fileOrNull(app, c)!;
        const content = await app.vault.read(f);
        await trash(app, f);
        undoDeleted.push({ path: c, content });
      },
    });
  }
  for (const d of entry.deleted!) {
    if (back.has(d)) continue;
    steps.push({
      path: d.path,
      run: async () => {
        await ensureFolder(app, parentFolder(d.path));
        await app.vault.create(d.path, d.content);
        undoCreates.push(d.path);
        undoCreatedHashes.push({ path: d.path, hash: createdHash(d.content) });
      },
    });
  }
  let done = 0;
  try {
    for (const s of steps) {
      await s.run();
      done++;
    }
  } catch (e) {
    failed.push({ path: "undo", error: messageOf(e) });
  }

  const journal = await writeJournal(
    app,
    settings,
    {
      op,
      ...(entry.schema !== undefined ? { schema: entry.schema } : {}),
      ...(currentActor() ? { actor: currentActor() } : {}),
      summary: `undo ${migrationId}`,
      executed_at: now.toISOString(),
      rows: undoRows,
      creates: undoCreates,
      ...(undoCreatedHashes.length > 0 ? { created_hashes: undoCreatedHashes } : {}),
      moves: undoMoves,
      references: undoReferences,
      deleted: undoDeleted,
      failed,
      undoes: migrationId,
      ...(undoPacks.length > 0 ? { packs: undoPacks } : {}),
    },
    now,
  );
  if (failed.length === 0) {
    await markUndone(app, settings, migrationId, journal.id, now);
  }
  return {
    ok: failed.length === 0,
    undoes: migrationId,
    migration_id: journal.id,
    conflicts: [],
    failed,
    ...(failed.length > 0 ? { left: [...new Set(steps.slice(done).map((s) => s.path))] } : {}),
    touched: [
      ...entry.rows.map((r) => r.path),
      ...entry.creates,
      ...[...entry.moves, ...since].flatMap((m) => [m.from, m.to]),
      ...entry.references.map((r) => r.path),
      ...entry.deleted!.map((d) => d.path),
    ],
  };
}

/** {@link applyChangeSetImpl}, traced: the files written, moved and deleted, with the journal entry. */
export function applyChangeSet(...args: Parameters<typeof applyChangeSetImpl>): ReturnType<typeof applyChangeSetImpl> {
  const cs = args[2];
  return phase("engine.apply", async (span) => {
    const r = await applyChangeSetImpl(...args);
    span.setAttributes({ "datanotes.notes_changed": r.notesChanged, "datanotes.files_created": r.filesCreated, "datanotes.files_moved": r.filesMoved, "datanotes.files_deleted": r.filesDeleted, "datanotes.failed": r.failed.length });
    if (!r.ok) span.setAttribute("error.type", "write_failed").setStatus("error", "the write failed partway");
    return r;
  }, { "datanotes.edits": cs.edits.length, "datanotes.creates": cs.creates.length, "datanotes.moves": cs.moves.length, "datanotes.deletes": cs.deletes.length });
}
