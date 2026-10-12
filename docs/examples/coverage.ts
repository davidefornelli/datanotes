/**
 * The examples must show every option that defines the database, like they use every operation,
 * so the pages cannot fall behind the engine. The options are read from the code, and what the
 * examples show is read from their runs:
 *
 * - **In `metastore.yaml`**, in the file's words: the members of the entry interfaces of
 *   src/core/metastore.ts (catalog, schema, table, table options, view, base), both values of
 *   their boolean members (`history: true` and `false`), the configuration keys
 *   (`DEFAULT_DATABASE_CONFIG`), the column attributes (`COLUMN_ATTRS`, as `columnToEntry` writes
 *   them), the column types, the `identity` kinds (`ColumnSpec`), the `{today}` / `{now}`
 *   defaults, `ref: self`, the kinds of `generated` expression, the keys of a view's query
 *   (`VIEW_QUERY_KEYS`), of a `union` and of its branches, and the `{this.*}` tokens. Each must
 *   appear in a `metastore.yaml` that an example page shows (`showFile`), as the engine wrote it.
 * - **In the calls**, in the operations' words: every parameter of the operations that write
 *   `metastore.yaml` (their description ends with the rule sentence), every column attribute and
 *   every table option (`TABLE_ATTRS`) must be passed by an example call shown on a page that the
 *   engine accepted (a refused call shows a refusal, not the option).
 *
 * `missingOptions` names what no page shows: the docs build (scripts/gen-docs.mjs) and
 * tests/examples.test.ts fail on it.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse } from "yaml";
import { OPERATIONS } from "../../src/api/catalog";
import { UNION_BRANCH_KEYS, UNION_QUERY_KEYS, VIEW_QUERY_KEYS } from "../../src/core/catalog-ops";
import { DEFAULT_DATABASE_CONFIG } from "../../src/core/database";
import { isLinkExpression, isTemplateExpression } from "../../src/core/generated";
import { columnToEntry } from "../../src/core/metastore";
import { COLUMN_ATTRS, TABLE_ATTRS } from "../../src/core/table-loader";
import { THIS_INNER, THIS_NOTE_FIELDS, THIS_WHOLE } from "../../src/core/this-tokens";
import { DEFAULT_NOW, DEFAULT_TODAY, SCALAR_COLUMN_TYPES } from "../../src/core/types-table";
import type { ChapterRun } from "./run";

/**
 * Options no page has to show, with the reason. Keep it short: an option of the database belongs
 * in an example.
 */
export const EXCEPTIONS: Readonly<Record<string, string>> = {
  // Every write takes it, with the same meaning: shown on insert_row (tables), alter_table
  // (structure), restore_table (history) and batch (writing), not on each operation.
  "dry_run": "a parameter of every write",
};

/**
 * Operations that write `metastore.yaml` without defining anything of their own: they group or
 * undo other operations' writes. (Their parameters are still shown: `batch` on writing,
 * `undo_migration` on most pages.)
 */
const NOT_DEFINING = new Set(["undo_migration", "batch"]);

/** The rule sentence that ends the description of every operation writing `metastore.yaml`. */
const WRITES_METASTORE = /never edit metastore\.yaml by hand/;

/** Members of the interfaces of a source file (index signatures left out). */
function interfaceMembers(file: string): Map<string, ts.PropertySignature[]> {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = new Map<string, ts.PropertySignature[]>();
  sf.forEachChild((n) => {
    if (ts.isInterfaceDeclaration(n)) out.set(n.name.text, n.members.filter(ts.isPropertySignature));
  });
  return out;
}

const names = (members: ts.PropertySignature[] | undefined) => (members ?? []).map((m) => m.name.getText());

/** The members typed `boolean`: `history?: boolean`. */
const booleans = (members: ts.PropertySignature[] | undefined) =>
  (members ?? []).filter((m) => m.type?.kind === ts.SyntaxKind.BooleanKeyword).map((m) => m.name.getText());

/** The string literals of a member's union type: `identity?: "filename" | "uuid" | "created"`. */
function literals(members: ts.PropertySignature[] | undefined, name: string): string[] {
  const type = members?.find((m) => m.name.getText() === name)?.type;
  const parts = type && ts.isUnionTypeNode(type) ? type.types : type ? [type] : [];
  return parts.flatMap((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : []));
}

/** The entry interfaces of `metastore.yaml`, by the prefix the options get. */
const ENTRIES: [string, string][] = [
  ["CatalogEntry", "catalog"],
  ["SchemaEntry", "schema"],
  ["CatalogTableEntry", "table"],
  ["TableProperties", "table.options"],
  ["ViewEntry", "view"],
  ["BaseEntry", "base"],
];

const generatedKind = (expr: string) => (isLinkExpression(expr) ? "link(…)" : isTemplateExpression(expr) ? "template" : "expression");

/** What a `{this.*}` token reads: a field every note has, or one of its properties (shifted). */
function tokenKind(field: string, shift: boolean): string {
  if (THIS_NOTE_FIELDS.has(field)) return `{this.${field}}`;
  return shift ? "{this.<property>±N}" : "{this.<property>}";
}

export interface Vocabulary {
  /** Options as `metastore.yaml` holds them. */
  file: string[];
  /** Options as the operations take them. */
  calls: string[];
}

/** Every option that defines the database, read from the code (`root`: the repository). */
export function optionVocabulary(root: string): Vocabulary {
  const metastore = interfaceMembers(path.join(root, "src", "core", "metastore.ts"));
  const tableTypes = interfaceMembers(path.join(root, "src", "core", "types-table.ts"));
  const file: string[] = [];
  for (const [iface, prefix] of ENTRIES) {
    const members = metastore.get(iface);
    if (!members) throw new Error(`docs/examples/coverage.ts: no interface ${iface} in src/core/metastore.ts`);
    for (const m of names(members)) file.push(`${prefix}.${m}`);
    for (const m of booleans(members)) file.push(`${prefix}.${m}: true`, `${prefix}.${m}: false`);
  }
  for (const k of Object.keys(DEFAULT_DATABASE_CONFIG)) file.push(`config.${k}`);
  // A column with every attribute, written the way the engine writes it.
  const every = Object.fromEntries([...COLUMN_ATTRS].map((k) => [k, k === "required" ? true : `${k}`]));
  for (const k of Object.keys(columnToEntry(every, true))) file.push(`column.${k}`);
  for (const t of [...SCALAR_COLUMN_TYPES, "list"]) file.push(`column.type: ${t}`);
  for (const k of literals(tableTypes.get("ColumnSpec"), "identity")) file.push(`column.identity: ${k}`);
  file.push(`column.default: ${DEFAULT_TODAY}`, `column.default: ${DEFAULT_NOW}`, "column.ref: self");
  for (const k of ["link(…)", "template", "expression"]) file.push(`column.generated: ${k}`);
  for (const k of VIEW_QUERY_KEYS) file.push(`view.query.${k}`);
  // Next to `union` the keys apply to every branch or to the stacked rows: only views have them.
  for (const k of UNION_QUERY_KEYS) if (k !== "union") file.push(`view.query.union + ${k}`);
  for (const k of UNION_BRANCH_KEYS) file.push(`view.query.union[].${k}`);
  for (const f of THIS_NOTE_FIELDS.keys()) file.push(`view.query: {this.${f}}`);
  file.push("view.query: {this.<property>}", "view.query: {this.<property>±N}", "base.column.ref: self");

  const calls: string[] = [];
  for (const op of OPERATIONS) {
    if (!WRITES_METASTORE.test(op.description) || NOT_DEFINING.has(op.name)) continue;
    for (const p of Object.keys((op.inputSchema.properties ?? {}) as object)) calls.push(`${op.name}.${p}`);
  }
  for (const a of COLUMN_ATTRS) calls.push(`column attribute ${a}`);
  for (const a of TABLE_ATTRS) calls.push(`table option ${a}`);
  return { file, calls };
}

const isRecord = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Strings anywhere in a value. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (isRecord(v)) return Object.values(v).flatMap(strings);
  return [];
}

/** The options a `metastore.yaml` holds. */
function fileOptions(text: string, seen: Set<string>): void {
  const ms = parse(text) as unknown;
  if (!isRecord(ms)) return;
  const keys = (v: unknown, prefix: string) => {
    if (!isRecord(v)) return;
    for (const [k, x] of Object.entries(v)) {
      seen.add(`${prefix}.${k}`);
      if (typeof x === "boolean") seen.add(`${prefix}.${k}: ${x}`);
    }
  };
  const column = (c: unknown) => {
    if (!isRecord(c)) return;
    keys(c, "column");
    if (typeof c.type === "string") seen.add(`column.type: ${c.type}`);
    if (typeof c.identity === "string") seen.add(`column.identity: ${c.identity}`);
    if (c.default === DEFAULT_TODAY || c.default === DEFAULT_NOW) seen.add(`column.default: ${c.default}`);
    if (c.ref === "self") seen.add("column.ref: self");
    if (typeof c.generated === "string") seen.add(`column.generated: ${generatedKind(c.generated)}`);
  };
  keys(ms.config, "config");
  for (const b of Object.values(isRecord(ms.bases) ? ms.bases : {})) {
    keys(b, "base");
    for (const c of isRecord(b) && Array.isArray(b.columns) ? b.columns : []) {
      column(c);
      if (isRecord(c) && c.ref === "self") seen.add("base.column.ref: self");
    }
  }
  for (const cat of Object.values(isRecord(ms.catalogs) ? ms.catalogs : {})) {
    keys(cat, "catalog");
    for (const sch of Object.values(isRecord(cat) && isRecord(cat.schemas) ? cat.schemas : {})) {
      keys(sch, "schema");
      if (!isRecord(sch)) continue;
      for (const t of Object.values(isRecord(sch.tables) ? sch.tables : {})) {
        keys(t, "table");
        if (!isRecord(t)) continue;
        keys(t.options, "table.options");
        for (const c of Array.isArray(t.columns) ? t.columns : []) column(c);
      }
      for (const v of Object.values(isRecord(sch.views) ? sch.views : {})) {
        keys(v, "view");
        if (!isRecord(v) || !isRecord(v.query)) continue;
        keys(v.query, "view.query");
        if (Array.isArray(v.query.union)) {
          for (const k of Object.keys(v.query)) if (k !== "union") seen.add(`view.query.union + ${k}`);
          for (const b of v.query.union) keys(b, "view.query.union[]");
        }
        for (const s of strings(v.query)) {
          const whole = THIS_WHOLE.exec(s);
          if (whole) seen.add(`view.query: ${tokenKind(whole[1]!, whole[2] !== undefined)}`);
          else for (const m of s.matchAll(THIS_INNER)) seen.add(`view.query: ${tokenKind(m[1]!, false)}`);
        }
      }
    }
  }
}

/** The options a call passes (a batch's operations each count). */
function callOptions(op: string, args: Record<string, unknown>, seen: Set<string>): void {
  for (const k of Object.keys(args)) seen.add(`${op}.${k}`);
  const columns = (v: unknown) => {
    for (const c of Array.isArray(v) ? v : [v]) if (isRecord(c)) for (const k of Object.keys(c)) seen.add(`column attribute ${k}`);
  };
  if (op === "create_table" || op === "define_base") columns(args.columns);
  if (op === "add_column") columns(args.column);
  if (op === "alter_column") columns(args.changes);
  if (op === "create_table" || op === "alter_table") for (const k of Object.keys(args)) seen.add(`table option ${k}`);
  if (op === "batch" && Array.isArray(args.operations)) {
    for (const o of args.operations) if (isRecord(o) && typeof o.op === "string") {
      const { op: inner, ...rest } = o;
      callOptions(inner, rest, seen);
    }
  }
}

/**
 * What the example pages show: the options in the `metastore.yaml` files shown, and in the calls
 * the engine accepted (a refused call shows what is refused, not how an option is used).
 */
export function optionsShown(runs: readonly ChapterRun[]): Vocabulary {
  const file = new Set<string>();
  const calls = new Set<string>();
  for (const run of runs) {
    for (const r of run.results.flat()) {
      if (r.file && r.file.path.endsWith("/metastore.yaml")) fileOptions(r.file.text, file);
      if (r.ok && r.step.op && r.args) callOptions(r.step.op, r.args, calls);
    }
  }
  return { file: [...file], calls: [...calls] };
}

const excepted = (option: string) => Object.keys(EXCEPTIONS).some((k) => option === k || option.endsWith(`.${k}`));

/** Options of the database no example page shows (empty when the pages show them all). */
export function missingOptions(runs: readonly ChapterRun[], root: string): Vocabulary {
  const all = optionVocabulary(root);
  const shown = optionsShown(runs);
  const fileShown = new Set(shown.file);
  const callsShown = new Set(shown.calls);
  return {
    file: all.file.filter((o) => !fileShown.has(o) && !excepted(o)),
    calls: all.calls.filter((o) => !callsShown.has(o) && !excepted(o)),
  };
}

/** The error message for missing options, or undefined when none is missing. */
export function missingOptionsMessage(missing: Vocabulary): string | undefined {
  if (missing.file.length === 0 && missing.calls.length === 0) return undefined;
  const parts = [
    ...(missing.file.length ? [`no page shows in metastore.yaml: ${missing.file.join(", ")}`] : []),
    ...(missing.calls.length ? [`no example call passes: ${missing.calls.join(", ")}`] : []),
  ];
  return `docs/examples: ${parts.join("; ")}. Add an example (with showFile of metastore.yaml for the file's options), or an entry with its reason to EXCEPTIONS in docs/examples/coverage.ts`;
}
