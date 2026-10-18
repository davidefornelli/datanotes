/**
 * Table model: a table is defined in the metastore (`metastore.yaml`), its rows are notes whose
 * `table` property names it, and its typed **columns** describe their properties.
 *
 * - A **dense** column is written on every row (with its default).
 * - A **sparse** column is known to the table (never `unknown`) but written only where a value
 *   exists.
 *
 * The engine works on an ordered description of each table (see `entryToOrdered`), where
 * `_table` holds the table options and `_columns` the column specs.
 */

/** Keys of the ordered description that hold table metadata; never written to rows. */
export const TABLE_KEY = "_table";
export const COLUMNS_KEY = "_columns";

export const SCALAR_COLUMN_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "enum",
  "link",
  /** Any YAML value (objects, lists of objects) — stored as is, not validated. */
  "json",
] as const;

export type ScalarColumnType = (typeof SCALAR_COLUMN_TYPES)[number];
export type ColumnType = ScalarColumnType | "list";

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  /** Element type when `type` is `list`. */
  items?: ScalarColumnType;
  required: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values when `type` (or `items`) is `enum`. */
  values?: readonly string[];
  /**
   * Enum only: what each value means and when to use it (`{stated: "the user said it", …}`).
   * Agents read it in describe_table; a refused value lists the allowed ones with it.
   */
  value_descriptions?: Readonly<Record<string, string>>;
  /**
   * Value given to the column when a row appears without the API — a note created by hand in a
   * table folder and adopted by the engine — and has none. Writes through the tools still have
   * to give the value themselves (a required column without it is refused).
   */
  external_default?: unknown;
  /** Target table name when `type` (or `items`) is `link`. */
  ref?: string;
  /**
   * Link columns only: the column of the `ref` table that links back (`friends` ↔ `friends`,
   * `children` ↔ `parents`). Writes keep both sides in step; declaring it on one side is enough.
   */
  inverse?: string;
  label?: string;
  /**
   * What the column holds: required of every column an operation creates (src/core/descriptions.ts);
   * a column written before the rule may have none.
   */
  description?: string;
  aliases: readonly string[];
  /** Optional wikilink to a documentation note (graph visibility). */
  note?: string;
  /** No two rows may share the same non-empty value. */
  unique?: boolean;
  /**
   * Enum only: `values` are in order (e.g. low < medium < high). Filters, sorting and
   * min/max/avg use the position (1-based); notes keep the word.
   */
  ordered?: boolean;
  /**
   * Generated column: its value is computed on every write from this expression
   * (`date(occurred_at)`, `date(occurred_at)+1`, or another column name) and cannot be set.
   */
  generated?: string;
  /**
   * `uuid`: a UUIDv7 assigned when the row is created and never changed (the system `id`).
   * `filename`: the row's file name (without `.md`), kept in sync on renames.
   * `created`: when the row was created (date or datetime column), set once and never changed;
   *   for an existing note without it, the file's creation time.
   */
  identity?: "filename" | "uuid" | "created";
  /**
   * Link column that orders rows of the same table in a tree (`parent`): the target must be a
   * row of this very table, and a row can never be its own ancestor.
   */
  hierarchy?: boolean;
  /**
   * Link column (or list of links) to its own table whose links never form a cycle (a task blocked
   * by a task it blocks). The links of its inverse column count too, reversed (acyclic.ts).
   */
  acyclic?: boolean;
  /**
   * Allowed values come from another table: the `name` of its rows (full `catalog.schema.table`).
   * For string columns and lists of strings, e.g. task `tags` from `personal.tasks.tag`.
   */
  vocabulary?: string;
  /**
   * Link columns only: a `where` filter every linked row must match (`{kind: {in: [area, project]}}`).
   * Checked at every write, by check_table, and again on the rows that link to a changed row.
   */
  ref_where?: Readonly<Record<string, unknown>>;
  /** Link columns only: the allowed targets depend on a column of the row itself (see {@link LinkLevels}). */
  ref_by?: LinkLevels;
}

/**
 * `ref_by` of a link column: the row's `column` (enum or string) picks the allowed values of the
 * linked row's `target_column` (default: the same name). `map[value]` is null for a top level (the
 * link must be empty) or the list of allowed target values (the link is then required). A row whose
 * value has no entry in the map is refused. `levels: [area, project, workstream]` is the shortcut
 * for a chain: each level's targets are the level before it, the first level has none; the map is
 * always expanded (describe_table shows it), `levels` is what metastore.yaml keeps.
 */
export interface LinkLevels {
  column: string;
  target_column?: string;
  levels?: readonly string[];
  map: Readonly<Record<string, readonly string[] | null>>;
}

/** The system row id every metastore table has: a UUIDv7, generated and immutable. */
export const SYSTEM_ID_COLUMN = "id";

/** Column spec of the system row id (as passed to create_table). */
export const SYSTEM_ID_SPEC = {
  name: SYSTEM_ID_COLUMN,
  type: "string",
  required: true,
  unique: true,
  identity: "uuid",
  description: "Unique id of the row (UUIDv7): set when the row is created, never changes",
} as const;

/** Column defaults evaluated when a row is written: the current date-time / date. */
export const DEFAULT_NOW = "{now}";
export const DEFAULT_TODAY = "{today}";

export interface TableOptions {
  /** Table name (the metastore key). */
  name?: string;
  /** Row sub-folder pattern inside the table folder, e.g. `{occurred_at:YYYY/MM}`; empty = flat. */
  partition?: string;
  /** Filename pattern for new rows (without `.md`). */
  filename?: string;
  /** Archive folder: a name inside the table folder (`_archive`), or a vault path. */
  archive?: string;
  /**
   * Folders whose notes are never rows, even when they link the schema — e.g. variant
   * Templater templates such as `Templates/` that create rows of this table.
   */
  exclude?: readonly string[];
  /**
   * What the table records — shown by `list_tables` so agents pick the right table. Required of
   * every table an operation creates (src/core/descriptions.ts); a table written before may have none.
   */
  description?: string;
  /** Other words for the table (e.g. `mood`, `how I feel`), for agents. */
  aliases?: readonly string[];
}

export interface TableColumn extends ColumnSpec {
  /** True when the column is written on every row (with its default). */
  dense: boolean;
}

export interface TableLayout {
  /** Folder of the table (`Datanotes/personal/metrics/mood`). */
  folder: string;
  /** Always true: every table lives in the database (kept in `describe_table` output). */
  inDatabase: true;
  /** Absolute folder pattern for new rows: the table folder, plus its partition. */
  rowPath: string;
  /** Absolute archive folder. */
  archive: string;
}

/** Default schema of a new database (`config.default_schema`). */
export const DEFAULT_SCHEMA = "public";

export interface TableDefinition {
  /** `<root>/metastore.yaml#catalog.schema.table` */
  schemaPath: string;
  name: string;
  /** Schema of the table in its catalog (`metrics` in `personal.metrics.mood`). */
  schema: string;
  /** Catalog of the table (`personal`). */
  catalog: string;
  /** Where rows and archived rows go, computed from database root, schema, name and options. */
  layout: TableLayout;
  options: TableOptions;
  columns: readonly TableColumn[];
  /** Defaults without a column (untyped, written on every new row). */
  untypedFields: readonly string[];
}

export type ViolationCode =
  | "required"
  | "inverse"
  | "type"
  | "min"
  | "max"
  | "step"
  | "enum"
  | "broken_link"
  | "ref"
  | "unique"
  | "unknown_column"
  | "check"
  | "generated"
  | "cycle"
  | "vocabulary"
  /** The row's front matter cannot be read (check_table, the change feed): no column. */
  | "unreadable";

export interface Violation {
  /** The column (every code but `check` and `unreadable`). */
  column?: string;
  /** The item of a list column that breaks the rule, from 0. */
  index?: number;
  /** The CHECK's name (code `check`). */
  constraint?: string;
  /** The CHECK's own hint (code `check`), when the constraint has one: how to fix the row. */
  hint?: string;
  code: ViolationCode;
  message: string;
  value?: unknown;
}
