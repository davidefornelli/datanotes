// The two Maintenance forms that delete or rewind for good, vacuum_table and restore_database (plan
// P8-fix): Apply only after a dry run that passed with the same arguments, and a confirmation that
// names what goes. Pure: no DOM, no fetch.

/** The form's arguments, or what is wrong with its input. */
export type Built<A> = { args: A; error: null } | { args: null; error: string };

/** A dry run that passed, with the key of the arguments it ran with. */
export interface Previewed<P> {
  key: string;
  preview: P;
}

/** One text per set of arguments: the order of the keys and `dry_run` do not count. */
export function argsKey(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(args)
      .filter((k) => k !== "dry_run")
      .sort()
      .map((k) => [k, args[k]]),
  );
}

/** Whether Apply may run: a dry run passed for exactly these arguments, and it found something to do. */
export function canApply<A extends Record<string, unknown>, P>(built: Built<A>, previewed: Previewed<P> | null, hasWork: (p: P) => boolean): boolean {
  if (built.args === null || previewed === null) return false;
  return previewed.key === argsKey(built.args) && hasWork(previewed.preview);
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// --- vacuum_table ---

export type VacuumArgs = { table: string; retain_from_version?: number };

/** vacuum_table's answer: the oldest version kept and the log files deleted (to delete, on a dry run). */
export interface VacuumAnswer {
  table: string;
  retained_from: number;
  deleted: string[];
}

export const PICK_TABLE = "pick a table";
export const VERSION_ERROR = "a version is a whole number, 0 or more: the table's history lists them";

/** The vacuum form's arguments: the table, and the version to keep from (empty: the latest). */
export function vacuumArgs(table: string, retainText: string): Built<VacuumArgs> {
  if (table === "") return { args: null, error: PICK_TABLE };
  const t = retainText.trim();
  if (t === "") return { args: { table }, error: null };
  const n = Number(t);
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(n)) return { args: null, error: VERSION_ERROR };
  return { args: { table, retain_from_version: n }, error: null };
}

/** A vacuum_table answer with this `dry_run`, or null for anything else. */
export function asVacuumAnswer(json: unknown, dryRun: boolean): VacuumAnswer | null {
  if (!isObject(json) || json.dry_run !== dryRun) return null;
  const { table, retained_from, deleted } = json;
  if (typeof table !== "string" || typeof retained_from !== "number" || !isStringList(deleted)) return null;
  return { table, retained_from, deleted };
}

export function vacuumHasWork(p: VacuumAnswer): boolean {
  return p.deleted.length > 0;
}

/** What the dry run found. */
export function vacuumPreviewText(p: VacuumAnswer): string {
  if (p.deleted.length === 0) return `Nothing to delete: ${p.table} has no log file older than version ${p.retained_from}.`;
  return `Apply deletes ${count(p.deleted.length, "log file", "log files")} of ${p.table}. Time travel then starts at version ${p.retained_from}.`;
}

/** The confirmation: the version the dry run kept and the number of files. */
export function vacuumConfirmText(p: VacuumAnswer): string {
  return `${count(p.deleted.length, "log file", "log files")} of ${p.table} will be deleted. Time travel before version ${p.retained_from} becomes impossible. This cannot be undone.`;
}

/**
 * What Apply sends: the version the dry run kept, by number. A write landing between the preview and
 * Apply moves the latest version; without the number, Apply would delete more than the preview listed.
 */
export function vacuumApplyArgs(args: VacuumArgs, p: VacuumAnswer): { table: string; retain_from_version: number; dry_run: false } {
  return { table: args.table, retain_from_version: p.retained_from, dry_run: false };
}

/** What the vacuum did. */
export function vacuumDoneText(a: VacuumAnswer): string {
  return `Deleted ${count(a.deleted.length, "log file", "log files")} of ${a.table}. Time travel now starts at version ${a.retained_from}.`;
}

// --- restore_database ---

export type RestoreBy = "timestamp" | "before_migration";
export type RestoreArgs = { timestamp: string } | { before_migration: string };

/** One table a restore changes (an entry of restore_database's `tables`). */
export interface RestoreTable {
  table: string;
  action: string;
  creates: string[];
  texts: string[];
  deletes: string[];
  archived: unknown[];
}

/** A restore_database dry run that passed. */
export interface RestorePreview {
  restored_to: string;
  tables: RestoreTable[];
  unchanged: string[];
  skipped: { table: string; reason: string }[];
}

export const TIMESTAMP_ERROR = "type a date or a date-time, such as 2026-11-01T09:00:00Z";
export const MIGRATION_ERROR = "type a migration_id or a batch id: the journal lists them";

/** The restore form's arguments: one moment, by time or by the operation to go back before. */
export function restoreArgs(by: RestoreBy, text: string): Built<RestoreArgs> {
  const t = text.trim();
  if (t === "") return { args: null, error: by === "timestamp" ? TIMESTAMP_ERROR : MIGRATION_ERROR };
  return { args: by === "timestamp" ? { timestamp: t } : { before_migration: t }, error: null };
}

function isRestoreTable(t: unknown): t is RestoreTable {
  return isObject(t) && typeof t.table === "string" && typeof t.action === "string" && isStringList(t.creates) && isStringList(t.texts) && isStringList(t.deletes) && Array.isArray(t.archived);
}

function isSkip(x: unknown): x is { table: string; reason: string } {
  return isObject(x) && typeof x.table === "string" && typeof x.reason === "string";
}

/** A restore_database dry run that passed (ok true), or null for anything else: a refusal, an error, a real run. */
export function asRestorePreview(json: unknown): RestorePreview | null {
  if (!isObject(json) || json.ok !== true || json.dry_run !== true) return null;
  const { restored_to, tables, unchanged, skipped } = json;
  if (typeof restored_to !== "string" || !Array.isArray(tables) || !tables.every(isRestoreTable)) return null;
  if (!isStringList(unchanged) || !Array.isArray(skipped) || !skipped.every(isSkip)) return null;
  return { restored_to, tables, unchanged, skipped };
}

export function restoreHasWork(p: RestorePreview): boolean {
  return p.tables.length > 0;
}

/** The row changes of some tables: "1 row re-created, 2 rows get their old text"; "no row changes" when none. */
export function restoreRowChanges(tables: RestoreTable[]): string {
  const sum = (part: (t: RestoreTable) => unknown[]) => tables.reduce((n, t) => n + part(t).length, 0);
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(count(n, one, many));
  };
  add(sum((t) => t.creates), "row re-created", "rows re-created");
  add(sum((t) => t.texts), "row gets its old text", "rows get their old text");
  add(sum((t) => t.deletes), "row deleted", "rows deleted");
  add(sum((t) => t.archived), "row archived", "rows archived");
  return parts.length > 0 ? parts.join(", ") : "no row changes";
}

/** What the dry run found. */
export function restorePreviewText(p: RestorePreview): string {
  if (p.tables.length === 0) return `Nothing to restore: every table with a log is already as it was at ${p.restored_to}.`;
  return `Apply restores ${count(p.tables.length, "table", "tables")} to ${p.restored_to}: ${restoreRowChanges(p.tables)}.`;
}

/** One table of the preview: "work.planning.task: restore (1 row gets its old text)". */
export function restoreTableLine(t: RestoreTable): string {
  return `${t.table}: ${t.action} (${restoreRowChanges([t])})`;
}

/** The confirmation: the moment, the tables and rows that change, and the tables that stay. */
export function restoreConfirmText(p: RestorePreview): string {
  const n = p.skipped.length;
  const skipped = n === 0 ? "" : n === 1 ? " 1 table has no history that far back and stays as it is." : ` ${n} tables have no history that far back and stay as they are.`;
  return `${count(p.tables.length, "table goes", "tables go")} back to ${p.restored_to}: ${restoreRowChanges(p.tables)}.${skipped} Changes made since then are undone. You can undo the restore from the journal.`;
}
