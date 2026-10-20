/**
 * The manifest of a Datanotes extension (`datanotes-extension.json`, format version 1): parsing, validation
 * with errors that teach (every problem at once, each as `<path>: <text>`), version comparison and the
 * binding of table roles to real tables. The installer reads only this file before the user confirms, so
 * everything an extension can do is declared here. No dependency but ./guidance.js.
 */

import { closestNames, DOCS_BASE } from "./guidance.js";

/** The manifest's file name at the root of the extension's repository. */
export const MANIFEST_FILE = "datanotes-extension.json";

/** Docs pages and headings that the errors of extensions point to (the pages are in docs/). */
export const EXT_DOCS = {
  install: `${DOCS_BASE}/administration/extensions.md#install-an-extension`,
  tables: `${DOCS_BASE}/administration/extensions.md#choose-the-tables-an-extension-uses`,
  permissions: `${DOCS_BASE}/administration/extensions.md#what-an-extension-can-do`,
  update: `${DOCS_BASE}/administration/extensions.md#update-an-extension`,
  rollback: `${DOCS_BASE}/administration/extensions.md#undo-an-install-or-an-update`,
  remove: `${DOCS_BASE}/administration/extensions.md#remove-an-extension`,
  skipped: `${DOCS_BASE}/administration/extensions.md#when-the-mcp-server-skips-an-extension`,
  where: `${DOCS_BASE}/administration/extensions.md#where-extensions-live`,
  layout: `${DOCS_BASE}/develop/write-an-extension.md#lay-out-the-repository`,
  manifest: `${DOCS_BASE}/develop/write-an-extension.md#write-the-manifest`,
  declare: `${DOCS_BASE}/develop/write-an-extension.md#declare-the-tables`,
  tools: `${DOCS_BASE}/develop/write-an-extension.md#write-the-tools`,
  migrations: `${DOCS_BASE}/develop/write-an-extension.md#migrate-the-schema-between-versions`,
  publish: `${DOCS_BASE}/develop/write-an-extension.md#check-and-publish-an-extension`,
} as const;

/** An extension's name (its token is `ext-<name>`). */
export const EXTENSION_NAME = /^[a-z][a-z0-9-]{1,39}$/;
/** A role, a table, a schema, a column, a base. */
export const IDENT = /^[a-z][a-z0-9_]*$/;
/** A tool's name. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The column types of the engine (a test checks the list against src/core). */
export const COLUMN_TYPES: readonly string[] = ["string", "number", "integer", "boolean", "date", "datetime", "enum", "link", "json", "list"];

/** The attributes of a column spec in the engine (src/core/table-loader.ts; a test checks the list). */
export const COLUMN_ATTRS: readonly string[] = [
  "name",
  "type",
  "items",
  "required",
  "default",
  "min",
  "max",
  "step",
  "values",
  "value_descriptions",
  "external_default",
  "ref",
  "label",
  "description",
  "aliases",
  "note",
  "unique",
  "ordered",
  "generated",
  "identity",
  "hierarchy",
  "acyclic",
  "vocabulary",
  "inverse",
  "ref_where",
  "ref_by",
];

/** The operations a batch takes (src/server/rest.ts; a test checks the list). */
export const BATCH_OPERATIONS: readonly string[] = [
  "insert_row",
  "update_row",
  "update_rows",
  "delete_rows",
  "merge_rows",
  "move_rows",
  "adopt_rows",
  "recompute_columns",
  "align_relations",
  "restore_table",
  "create_table",
  "drop_table",
  "alter_table",
  "clone_table",
  "add_column",
  "rename_column",
  "drop_column",
  "alter_column",
  "rename_value",
  "comment_on",
  "define_base",
  "set_table_bases",
  "add_constraint",
  "drop_constraint",
  "create_view",
  "drop_view",
];

/** The operations that write rows. */
export const DATA_OPERATIONS: readonly string[] = [
  "insert_row",
  "update_row",
  "update_rows",
  "delete_rows",
  "merge_rows",
  "move_rows",
  "adopt_rows",
  "recompute_columns",
  "align_relations",
];

/** An extension's own error: what is wrong, how to fix it, where to read more. */
export class ExtensionError extends Error {
  override readonly name: string = "ExtensionError";
  constructor(
    message: string,
    readonly hint: string,
    readonly docs: string,
    readonly code: string = "extension",
  ) {
    super(message);
  }
}

/** A manifest that is not valid: every problem, in the order of the walk. */
export class ExtensionManifestError extends ExtensionError {
  override readonly name = "ExtensionManifestError";
  constructor(
    readonly problems: string[],
    file: string = MANIFEST_FILE,
  ) {
    super(
      `${file}: ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.join("; ")}`,
      "Fix each problem in the manifest, then check the folder again: datanotes extension check <folder>.",
      EXT_DOCS.manifest,
      "manifest",
    );
  }
}

// --- types ------------------------------------------------------------------------------------------

/** Whether a table the extension depends on must have the column. */
export type ColumnNeed = "required" | "optional";

/** A column spec as the engine's operations take it, plus `need`. */
export interface ManifestColumn {
  name: string;
  type: string;
  description: string;
  need: ColumnNeed;
  [attribute: string]: unknown;
}

export interface ManifestConstraint {
  name: string;
  check: Record<string, unknown>;
  hint: string;
}

export interface ManifestTable {
  owned: boolean;
  /** The table's name when created; the role when missing. */
  name?: string;
  schema?: string;
  names?: string[];
  description: string;
  aliases?: string[];
  filename?: string;
  columns: ManifestColumn[];
  constraints?: ManifestConstraint[];
  instructions?: string;
  bases?: string[];
}

export interface ManifestBase {
  description: string;
  columns: ManifestColumn[];
}

export interface ManifestView {
  description: string;
  query: Record<string, unknown>;
  aliases?: string[];
  labels?: Record<string, unknown>;
}

export interface ManifestTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  /** Roles the tool reads or writes. */
  tables: string[];
  /** Roles the tool writes. */
  writes: string[];
}

export interface ManifestMigration {
  version: string;
  description: string;
  operations: ({ op: string } & Record<string, unknown>)[];
}

export interface ExtensionManifest {
  manifest_version: 1;
  name: string;
  version: string;
  description: string;
  datanotes: string;
  api: 1;
  entry: string;
  default_schema: string;
  instructions?: string;
  tables: Record<string, ManifestTable>;
  /** The keys of `tables`, in order. */
  roles: string[];
  bases: Record<string, ManifestBase>;
  views: Record<string, ManifestView>;
  permissions: { write: string[] };
  tools: ManifestTool[];
  migrations: ManifestMigration[];
}

// --- versions ---------------------------------------------------------------------------------------

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

/** MAJOR.MINOR.PATCH[-pre] (no leading `v`); null when it is not a version. */
export function parseVersion(v: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null } : null;
}

const NUMERIC = /^\d+$/;

/** Negative when a is older than b, 0 when equal, positive when newer. Throws for text that is not a version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  if (!x) throw new Error(`not a version: ${a}`);
  const y = parseVersion(b);
  if (!y) throw new Error(`not a version: ${b}`);
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const p = xs[i]!;
    const q = ys[i]!;
    if (p === q) continue;
    const pn = NUMERIC.test(p);
    const qn = NUMERIC.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return xs.length - ys.length;
}

/** Whether an engine version meets a manifest's `">=X.Y.Z"`. A source run ("dev", "") meets every range. */
export function satisfiesEngine(range: string, engineVersion: string): boolean {
  if (engineVersion === "" || engineVersion === "dev") return true;
  const r = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!r) return false;
  const e = /^(\d+)\.(\d+)\.(\d+)/.exec(engineVersion);
  if (!e) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(e[i]) - Number(r[i]);
    if (d !== 0) return d > 0;
  }
  return true;
}

// --- roles ------------------------------------------------------------------------------------------

/** A string that is exactly a role: `@task`. */
export const ROLE_REF = /^@([a-z][a-z0-9_]*)$/;
/** A role inside a text: `@{task}`. */
export const ROLE_TEXT = /@\{([a-z][a-z0-9_]*)\}/g;

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** A deep copy of `value` with every `@role` string and every `@{role}` in a string replaced by the role's table. Keys stay. */
export function bindRoles<T>(value: T, tables: Readonly<Record<string, string>>): T {
  const table = (role: string): string => {
    if (!has(tables, role)) throw new Error(`no table for role ${role}`);
    return tables[role]!;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const exact = ROLE_REF.exec(v);
      return exact ? table(exact[1]!) : v.replace(new RegExp(ROLE_TEXT.source, "g"), (_m, role: string) => table(role));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) {
      const out: Obj = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** The roles a value names, in order of first appearance (both forms). */
export function rolesNamed(value: unknown): string[] {
  const out: string[] = [];
  const add = (role: string): void => {
    if (!out.includes(role)) out.push(role);
  };
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const exact = ROLE_REF.exec(v);
      if (exact) return add(exact[1]!);
      const re = new RegExp(ROLE_TEXT.source, "g");
      for (let m = re.exec(v); m; m = re.exec(v)) add(m[1]!);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) Object.keys(v).forEach((k) => walk(v[k]));
  };
  walk(value);
  return out;
}

// --- parsing and validation -------------------------------------------------------------------------

const TOP_KEYS = ["manifest_version", "name", "version", "description", "datanotes", "api", "entry", "default_schema", "instructions", "tables", "bases", "views", "permissions", "tools", "migrations"];
const TABLE_KEYS = ["owned", "name", "schema", "names", "description", "aliases", "filename", "columns", "constraints", "instructions", "bases"];
const CONSTRAINT_KEYS = ["name", "check", "hint"];
const BASE_KEYS = ["description", "columns"];
const VIEW_KEYS = ["description", "query", "aliases", "labels"];
const TOOL_KEYS = ["name", "description", "inputSchema", "annotations", "tables", "writes"];
const MIGRATION_KEYS = ["version", "description", "operations"];
const COLUMN_KEYS = [...COLUMN_ATTRS, "need"];
const IDENT_TEXT = "lowercase letters, digits and _";
/** The `ref` of a column is checked with its column; the generic `@role` walk leaves it out. */
const COLUMN_REF_PATH = /^(tables|bases)\.[^.]+\.columns\[\d+\]\.ref$/;

/** Read a manifest's text (a leading BOM is fine) and validate it. */
export function parseManifest(text: string, file: string = MANIFEST_FILE): ExtensionManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new ExtensionManifestError([`not JSON: ${(e as Error).message}`], file);
  }
  return validateManifest(raw, file);
}

/** Check a parsed manifest, collecting every problem; returns the typed manifest (a deep copy) or throws ExtensionManifestError. */
export function validateManifest(raw: unknown, file: string = MANIFEST_FILE): ExtensionManifest {
  if (!isObject(raw)) throw new ExtensionManifestError(["the manifest must be a JSON object"], file);
  const problems: string[] = [];
  const m = JSON.parse(JSON.stringify(raw)) as Obj;
  const add = (path: string, text: string): void => {
    problems.push(path ? `${path}: ${text}` : text);
  };
  const keys = (o: Obj, allowed: readonly string[], path: string): void => {
    for (const k of Object.keys(o)) {
      if (allowed.includes(k)) continue;
      const near = closestNames(k, allowed)[0];
      add(path, `unknown key "${k}"${near ? ` (did you mean "${near}"?)` : ""}`);
    }
  };
  const ident = (v: unknown): v is string => typeof v === "string" && IDENT.test(v);
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
  const needDescription = (o: Obj, path: string): void => {
    if (!nonEmpty(o.description)) add(`${path}.description`, "is required");
  };
  const tablesRaw: Obj = isObject(m.tables) ? m.tables : {};
  const roles = Object.keys(tablesRaw);
  const basesRaw: Obj = isObject(m.bases) ? m.bases : {};
  const permWrite: unknown[] = isObject(m.permissions) && Array.isArray(m.permissions.write) ? m.permissions.write : [];
  /** Check each element of a list of roles. */
  const roleList = (v: unknown, path: string, allowed: readonly unknown[], notText: (r: string) => string): void => {
    if (!Array.isArray(v)) return add(path, "must be a list of roles");
    v.forEach((r, i) => {
      if (!allowed.includes(r)) add(`${path}[${i}]`, notText(String(r)));
    });
  };

  /** One column spec; `refs` are the roles a ref may name, `inBase` limits a ref to "self". */
  const column = (c: unknown, path: string, refs: readonly string[], inBase: boolean): void => {
    if (!isObject(c)) return add(path, "must be an object");
    keys(c, COLUMN_KEYS, path);
    if (!ident(c.name)) add(`${path}.name`, `must be ${IDENT_TEXT}`);
    else if (c.name === "id") add(path, `"id" is the engine's own column: leave it out`);
    if (typeof c.type !== "string" || !COLUMN_TYPES.includes(c.type)) add(`${path}.type`, `"${String(c.type)}" is not a column type (${COLUMN_TYPES.join(", ")})`);
    else if (c.type === "list" && !nonEmpty(c.items)) add(`${path}.items`, "a list column needs items");
    if (c.need !== undefined && c.need !== "required" && c.need !== "optional") add(`${path}.need`, `must be "required" or "optional"`);
    if (c.ref !== undefined && c.ref !== "self") {
      const named = typeof c.ref === "string" ? ROLE_REF.exec(c.ref) : null;
      if (inBase) add(`${path}.ref`, `must be "self" in a base`);
      else if (!named || !refs.includes(named[1]!)) add(`${path}.ref`, `must be "self" or "@<role>" of a table declared before this one`);
    }
    if (c.inverse !== undefined && c.ref !== "self") add(`${path}.inverse`, `only on a column with ref "self" in manifest version 1`);
    needDescription(c, path);
  };

  /** A list of columns; a name used twice is reported at its second use. */
  const columns = (v: unknown, path: string, refs: readonly string[], inBase: boolean): void => {
    if (!Array.isArray(v)) return add(path, "must be a list");
    const seen = new Set<string>();
    v.forEach((c, i) => {
      column(c, `${path}[${i}]`, refs, inBase);
      const name = isObject(c) ? c.name : undefined;
      if (typeof name !== "string") return;
      if (seen.has(name)) add(path, `column "${name}" twice`);
      seen.add(name);
    });
  };

  // top level
  keys(m, TOP_KEYS, "");
  if (m.manifest_version !== 1) add("manifest_version", "must be 1");
  if (typeof m.name !== "string" || !EXTENSION_NAME.test(m.name)) add("name", "must be 2 to 40 lowercase letters, digits or -, starting with a letter");
  const version = typeof m.version === "string" ? parseVersion(m.version) : null;
  if (!version) add("version", `"${String(m.version)}" is not a version (MAJOR.MINOR.PATCH)`);
  if (typeof m.description !== "string" || m.description.length < 1 || m.description.length > 300) add("description", "is required (1 to 300 characters)");
  if (typeof m.datanotes !== "string" || !/^>=\d+\.\d+\.\d+$/.test(m.datanotes)) add("datanotes", `must be ">=X.Y.Z", such as ">=3.3.0"`);
  if (m.api !== 1) add("api", "must be 1");
  const entry = m.entry;
  if (typeof entry !== "string" || !entry.endsWith(".mjs") || /^([/]|[A-Za-z]:)/.test(entry) || entry.includes("\\") || entry.split("/").some((s) => s === "" || s === "." || s === "..")) {
    add("entry", "must be a relative path to a .mjs file inside the repository");
  }
  if (!ident(m.default_schema)) add("default_schema", `must be ${IDENT_TEXT}`);
  if (m.instructions !== undefined && (typeof m.instructions !== "string" || m.instructions.length < 1 || m.instructions.length > 400)) add("instructions", "must be 1 to 400 characters");

  // tables
  if (roles.length === 0) add("tables", "needs at least one table");
  roles.forEach((role, index) => {
    const path = `tables.${role}`;
    const t = tablesRaw[role];
    if (!IDENT.test(role)) add(path, `a role is ${IDENT_TEXT}`);
    if (!isObject(t)) return add(path, "must be an object");
    keys(t, TABLE_KEYS, path);
    if (typeof t.owned !== "boolean") add(`${path}.owned`, "must be true or false");
    for (const k of ["name", "schema"]) if (t[k] !== undefined && !ident(t[k])) add(`${path}.${k}`, `must be ${IDENT_TEXT}`);
    if (t.names !== undefined) {
      if (t.owned === true) add(`${path}.names`, "only a table the extension depends on has names");
      else if (!Array.isArray(t.names) || !t.names.every((n) => typeof n === "string")) add(`${path}.names`, "must be a list of names");
    }
    needDescription(t, path);
    columns(t.columns, `${path}.columns`, roles.slice(0, index), false);
    if (t.owned === false) {
      for (const k of ["constraints", "instructions", "bases"]) if (t[k] !== undefined) add(`${path}.${k}`, `only a table the extension owns has ${k}`);
      return;
    }
    if (t.constraints !== undefined) {
      if (!Array.isArray(t.constraints)) add(`${path}.constraints`, "must be a list");
      else {
        const seen = new Set<string>();
        t.constraints.forEach((c: unknown, i: number) => {
          const cp = `${path}.constraints[${i}]`;
          if (!isObject(c)) return add(cp, "must be an object");
          keys(c, CONSTRAINT_KEYS, cp);
          if (!ident(c.name)) add(`${cp}.name`, `must be ${IDENT_TEXT}`);
          else {
            if (seen.has(c.name)) add(`${path}.constraints`, `constraint "${c.name}" twice`);
            seen.add(c.name);
          }
          if (!isObject(c.check)) add(`${cp}.check`, "must be an object");
          if (typeof c.hint !== "string") add(`${cp}.hint`, "must be a string");
        });
      }
    }
    if (t.instructions !== undefined && !nonEmpty(t.instructions)) add(`${path}.instructions`, "must be a non-empty string");
    if (t.bases !== undefined) {
      if (!Array.isArray(t.bases)) add(`${path}.bases`, "must be a list");
      else {
        t.bases.forEach((b: unknown, i: number) => {
          if (typeof b !== "string" || !has(basesRaw, b)) add(`${path}.bases[${i}]`, `base "${String(b)}" is not in bases`);
        });
      }
    }
  });

  // bases
  if (m.bases !== undefined && !isObject(m.bases)) add("bases", "must be an object");
  for (const b of Object.keys(basesRaw)) {
    const path = `bases.${b}`;
    const base = basesRaw[b];
    if (!IDENT.test(b)) add(path, `a base name is ${IDENT_TEXT}`);
    if (!isObject(base)) {
      add(path, "must be an object");
      continue;
    }
    keys(base, BASE_KEYS, path);
    needDescription(base, path);
    columns(base.columns, `${path}.columns`, [], true);
  }

  // views
  if (m.views !== undefined && !isObject(m.views)) add("views", "must be an object");
  const viewsRaw: Obj = isObject(m.views) ? m.views : {};
  for (const v of Object.keys(viewsRaw)) {
    const path = `views.${v}`;
    const view = viewsRaw[v];
    if (!/^vw_[a-z0-9_]+$/.test(v)) add(path, `a view name starts with vw_ and is ${IDENT_TEXT}`);
    if (!isObject(view)) {
      add(path, "must be an object");
      continue;
    }
    keys(view, VIEW_KEYS, path);
    needDescription(view, path);
    if (!isObject(view.query)) add(`${path}.query`, "must be an object");
  }

  // permissions
  if (!isObject(m.permissions)) add("permissions", `must be an object with a "write" list of roles`);
  else {
    keys(m.permissions, ["write"], "permissions");
    roleList(m.permissions.write, "permissions.write", roles, (r) => `"${r}" is not a role`);
  }

  // tools
  if (!Array.isArray(m.tools)) add("tools", "must be a list");
  else {
    const seen = new Set<string>();
    m.tools.forEach((t: unknown, i: number) => {
      const path = `tools[${i}]`;
      if (!isObject(t)) return add(path, "must be an object");
      keys(t, TOOL_KEYS, path);
      if (typeof t.name !== "string" || !TOOL_NAME.test(t.name)) add(`${path}.name`, "must be snake_case, 1 to 64 characters");
      else {
        if (seen.has(t.name)) add("tools", `tool "${t.name}" twice`);
        seen.add(t.name);
      }
      if (!nonEmpty(t.description)) add(`${path}.description`, "is required");
      if (!isObject(t.inputSchema) || t.inputSchema.type !== "object" || t.inputSchema.additionalProperties !== false) {
        add(`${path}.inputSchema`, `must be an object schema with "type": "object" and "additionalProperties": false`);
      }
      const readOnly = isObject(t.annotations) ? t.annotations.readOnlyHint : undefined;
      if (readOnly !== undefined && typeof readOnly !== "boolean") add(`${path}.annotations.readOnlyHint`, "must be true or false");
      if (t.tables !== undefined) roleList(t.tables, `${path}.tables`, roles, (r) => `"${r}" is not a role`);
      if (t.writes !== undefined) roleList(t.writes, `${path}.writes`, permWrite, (r) => `"${r}" is not in permissions.write`);
      const writes = Array.isArray(t.writes) ? t.writes.length : 0;
      if (writes > 0 && readOnly === true) add(path, "a read-only tool writes nothing (empty writes, or readOnlyHint false)");
      else if (writes > 0 && readOnly === undefined) add(path, "a tool that writes has readOnlyHint false");
    });
  }

  // migrations
  if (m.migrations !== undefined && !Array.isArray(m.migrations)) add("migrations", "must be a list");
  let previous: string | null = null;
  (Array.isArray(m.migrations) ? m.migrations : []).forEach((g: unknown, i: number) => {
    const path = `migrations[${i}]`;
    if (!isObject(g)) return add(path, "must be an object");
    keys(g, MIGRATION_KEYS, path);
    const at = g.version;
    if (typeof at !== "string" || !parseVersion(at)) add(`${path}.version`, `"${String(at)}" is not a version`);
    else {
      if (previous !== null && compareVersions(previous, at) >= 0) add("migrations", `versions must increase (${previous} before ${at})`);
      if (version && compareVersions(at, m.version as string) > 0) add(`${path}.version`, `${at} is later than the extension's version ${String(m.version)}`);
      previous = at;
    }
    needDescription(g, path);
    if (!Array.isArray(g.operations)) add(`${path}.operations`, "must be a list");
    else {
      g.operations.forEach((o: unknown, j: number) => {
        const op = isObject(o) ? o.op : undefined;
        if (typeof op !== "string" || !BATCH_OPERATIONS.includes(op)) add(`${path}.operations[${j}].op`, `"${String(op)}" is not an operation a batch takes`);
      });
    }
  });

  // @role and @{role} must name a role
  const known = new Set(roles);
  const names = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      const exact = ROLE_REF.exec(v);
      if (exact) {
        if (!known.has(exact[1]!) && !COLUMN_REF_PATH.test(path)) add(path, `"@${exact[1]}" names no role`);
        return;
      }
      const re = new RegExp(ROLE_TEXT.source, "g");
      for (let r = re.exec(v); r; r = re.exec(v)) if (!known.has(r[1]!)) add(path, `"@{${r[1]}}" names no role`);
    } else if (Array.isArray(v)) v.forEach((x, i) => names(x, `${path}[${i}]`));
    else if (isObject(v)) for (const k of Object.keys(v)) names(v[k], `${path}.${k}`);
  };
  for (const part of ["tables", "bases", "views", "migrations"]) if (m[part] !== undefined) names(m[part], part);

  if (problems.length > 0) throw new ExtensionManifestError(problems, file);

  // the typed copy: defaults filled in
  const needed = (cols: ManifestColumn[]): void => {
    for (const c of cols) c.need = c.need ?? "required";
  };
  for (const role of roles) needed((tablesRaw[role] as unknown as ManifestTable).columns);
  m.bases = basesRaw;
  for (const b of Object.keys(basesRaw)) needed((basesRaw[b] as unknown as ManifestBase).columns);
  m.views = viewsRaw;
  for (const t of m.tools as Partial<ManifestTool>[]) {
    t.annotations = t.annotations ?? {};
    t.tables = t.tables ?? [];
    t.writes = t.writes ?? [];
  }
  m.migrations = ((m.migrations ?? []) as ManifestMigration[]).sort((a, b) => compareVersions(a.version, b.version));
  m.roles = roles;
  return m as unknown as ExtensionManifest;
}
