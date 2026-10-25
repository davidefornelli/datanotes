/**
 * pack_rows and unpack_rows: put the rows of a table's closed periods into packs (one note per
 * period, a `##` section per row: pack-format.ts), and take them out again as notes of their own.
 *
 * Both are silent for the rows: a row keeps its id, its path, its values, its text and its
 * `file_modified` (the host lists it at the same path: `App.packs`), so no change event, no
 * webhook, no new version of the table. The links other notes have to the rows follow (to
 * `[[pack#row]]` when they go in, back when they come out): those notes are written as any write
 * writes them, in the same migration, which undo_migration takes back whole.
 */

import type { App, LinkRewrite } from "./host";
import { emptyChangeSet, type PackChange } from "./changeset";
import { finish, instrumented, loadRows, loadTable, OperationInputError, packOptions, type OpConflict, type OpResult, type RunOptions } from "./engine";
import type { DatanotesSettings } from "./settings";
import { readDatabaseConfig } from "./database";
import { wallClock } from "./datetime";
import { compileWhere, resolveWithin, type Where } from "./where";
import { fmGet } from "./frontmatter";
import { packable } from "./pack-format";
import { DEFAULT_PACK_AFTER_DAYS, PACK_QUIET_MS, packFilePath, packKeyOf, periodClosed, readPackTemplate, rowPathOf } from "./pack-layout";
import { basenameOf } from "./path-templates";
import { guide } from "./hints";

export interface PackRowsInput {
  table: string;
  /** Only the period of this key (`2026-10`); all closed periods when absent. */
  key?: string;
}

export interface UnpackRowsInput {
  table: string;
  /** Only the pack of this key; every pack of the table when absent. */
  key?: string;
  /** Only the rows that match (as select_rows' `where`). */
  where?: Where;
}

/** A pack an operation writes (or would): its file, its key and the rows that go in or come out. */
export interface PlannedPack {
  pack: string;
  key: string;
  rows: string[];
}

/** A row of a closed period that stays a note of its own, and why. */
export interface ExcludedRow {
  path: string;
  reason: string;
}

/** What pack_rows and unpack_rows answer: a write's answer, with the packs and the rows left out. */
export interface PackRowsResult extends OpResult {
  packs: PlannedPack[];
  /** pack_rows: rows of closed periods that stay notes of their own, with the reason. */
  excluded?: ExcludedRow[];
  /** pack_rows: rows whose period is not closed yet (not listed). */
  open_rows?: number;
}

const needPacks = (app: App, table: string) => {
  if (!app.packs) {
    throw new OperationInputError(
      `${table}: packs of rows need the engine service (datanotes serve); this host keeps every row in a note of its own`,
      guide("Run the operation through the engine service (datanotes serve, its HTTP API or its MCP server).", "packHost"),
    );
  }
  return app.packs;
};

/** The links of other notes to these rows, rewritten (see PackStore.relinks); none on a host that cannot. */
async function relinks(app: App, rows: readonly string[], to: "pack" | "note", targets: ReadonlyMap<string, { pack: string; heading: string }>): Promise<LinkRewrite[]> {
  return app.packs?.relinks ? app.packs.relinks(rows, to, targets) : [];
}

async function packRowsImpl(app: App, settings: DatanotesSettings, input: PackRowsInput, opts: RunOptions = {}): Promise<PackRowsResult> {
  const t = await loadTable(app, settings, input.table);
  const full = t.catalog.ref.full;
  const packs = needPacks(app, full);
  const option = t.catalog.entry.options?.pack;
  if (typeof option !== "string") {
    throw new OperationInputError(
      `${full} has no "pack" option: its rows stay notes of their own`,
      guide(`Set the period of the table's packs first, such as alter_table {"table": "${full}", "pack": "{${t.def.columns.find((c) => c.type === "date" || c.type === "datetime")?.name ?? "occurred_at"}:YYYY-MM}"}, after the user agrees.`, "packOption"),
    );
  }
  const template = readPackTemplate(option, t.def.columns);
  const after = typeof t.catalog.entry.options?.pack_after_days === "number" ? t.catalog.entry.options.pack_after_days : DEFAULT_PACK_AFTER_DAYS;
  if (input.key !== undefined && (typeof input.key !== "string" || input.key.trim() === "")) {
    throw new OperationInputError(`"key" must be the period of a pack, such as 2026-10`, guide(`Pass the key as the table's pack option writes it (${template.template}), or leave it out for every closed period.`, "packRows"));
  }
  const now = opts.now ?? new Date();
  const cfg = await readDatabaseConfig(app, settings);
  const today = wallClock(now, cfg.timezone).slice(0, 10);
  const layout = { rowPath: t.def.layout.rowPath, filename: t.def.options.filename ?? "" };
  const groups = new Map<string, string[]>();
  const excluded: ExcludedRow[] = [];
  let open = 0;
  for (const r of await loadRows(app, settings, t)) {
    const p = r.file.path;
    if (packs.locate(p)) continue; // in a pack already
    const values = new Map(r.ordered);
    const key = packKeyOf(template, values);
    if (input.key !== undefined && key !== input.key) continue;
    if (key === null) {
      excluded.push({ path: p, reason: `it has no ${template.column}` });
      continue;
    }
    if (!periodClosed(String(fmGet(r.ordered, template.column)), template.period, after, today)) {
      open++;
      continue;
    }
    const mtime = r.file.stat?.mtime ?? 0;
    if (now.getTime() - mtime < PACK_QUIET_MS) {
      excluded.push({ path: p, reason: "it changed in the last 24 hours" });
      continue;
    }
    let expected: string | null = null;
    try {
      expected = layout.filename ? rowPathOf(layout, values) : null;
    } catch {
      expected = null;
    }
    if (expected !== p) {
      excluded.push({ path: p, reason: `it is not at the path its values give${expected ? ` (${expected})` : ""}` });
      continue;
    }
    const ok = packable(await app.vault.read(r.file), basenameOf(p), full, settings.tableKey);
    if (!ok.ok) {
      excluded.push({ path: p, reason: ok.reason });
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const planned: PlannedPack[] = [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, rows]) => ({ pack: packFilePath(t.def.layout.folder, t.def.name, key), key, rows }));
  const conflicts: OpConflict[] = [];
  for (const p of planned) {
    const existing = packs.packsOf(full).find((x) => x.key === p.key);
    if (existing && existing.path !== p.pack) p.pack = existing.path; // a pack of the key under another name (renamed by hand)
    else if (!existing && app.vault.getAbstractFileByPath(p.pack) != null) conflicts.push({ path: p.pack, message: `a note has the name of the pack of ${p.key}: rename it first` });
  }
  const cs = emptyChangeSet("pack_rows", `pack ${planned.reduce((n, p) => n + p.rows.length, 0)} rows of ${t.def.name}`, t.def.schemaPath);
  const targets = new Map<string, { pack: string; heading: string }>();
  for (const p of planned) for (const r of p.rows) targets.set(r, { pack: p.pack, heading: basenameOf(r) });
  for (const l of await relinks(app, [...targets.keys()], "pack", targets)) cs.texts.push({ path: l.path, before: l.before, after: l.after });
  cs.packs = planned.map((p): PackChange => ({ action: "pack", table: full, key: p.key, pack: p.pack, rows: p.rows, tableKey: settings.tableKey }));
  const result = planned.length === 0 && conflicts.length === 0 ? { ...emptyResultOf("pack_rows", opts), ok: true } : await finish(app, settings, cs, conflicts, [], opts);
  return { ...result, packs: planned, excluded: excluded.sort((a, b) => (a.path < b.path ? -1 : 1)), open_rows: open };
}

async function unpackRowsImpl(app: App, settings: DatanotesSettings, input: UnpackRowsInput, opts: RunOptions = {}): Promise<PackRowsResult> {
  const t = await loadTable(app, settings, input.table);
  const full = t.catalog.ref.full;
  const packs = needPacks(app, full);
  let chosen = packs.packsOf(full);
  if (input.key !== undefined) chosen = chosen.filter((p) => p.key === input.key);
  let only: Set<string> | null = null;
  if (input.where !== undefined) {
    const pred = compileWhere(await resolveWithin(app, settings, t, input.where), t, settings);
    only = new Set((await loadRows(app, settings, t)).filter(pred).map((r) => r.file.path));
  }
  const planned: PlannedPack[] = chosen
    .map((p) => ({ pack: p.path, key: p.key, rows: only ? p.rows.filter((r) => only!.has(r)) : p.rows }))
    .filter((p) => p.rows.length > 0);
  const cs = emptyChangeSet("unpack_rows", `unpack ${planned.reduce((n, p) => n + p.rows.length, 0)} rows of ${t.def.name}`, t.def.schemaPath);
  const targets = new Map<string, { pack: string; heading: string }>();
  for (const p of planned) for (const r of p.rows) targets.set(r, { pack: p.pack, heading: basenameOf(r) });
  for (const l of await relinks(app, [...targets.keys()], "note", targets)) cs.texts.push({ path: l.path, before: l.before, after: l.after });
  cs.packs = planned.map((p): PackChange => ({ action: "unpack", table: full, key: p.key, pack: p.pack, rows: p.rows, tableKey: settings.tableKey }));
  const result = planned.length === 0 ? { ...emptyResultOf("unpack_rows", opts), ok: true } : await finish(app, settings, cs, [], [], opts);
  return { ...result, packs: planned };
}

/** The answer of an operation with nothing to do. */
function emptyResultOf(op: string, opts: RunOptions): OpResult {
  return {
    ok: true,
    op,
    dry_run: opts.dryRun === true,
    notes_changed: 0,
    files_created: 0,
    files_moved: 0,
    files_deleted: 0,
    references_updated: 0,
    conflicts: [],
    violations: [],
    failed: [],
    planned_edits: [],
    planned_creates: [],
    planned_moves: [],
    planned_deletes: [],
    planned_texts: [],
  };
}

/** The table's pack option, checked (for create_table / alter_table): re-exported for callers. */
export { packOptions };

export const packRows = instrumented("pack_rows", packRowsImpl, (i) => ({ table: i.table, key: i.key }));
export const unpackRows = instrumented("unpack_rows", unpackRowsImpl, (i) => ({ table: i.table, key: i.key }));
