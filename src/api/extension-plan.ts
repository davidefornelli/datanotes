/**
 * The install plan of a Datanotes extension: which table each role of the manifest uses, how the
 * existing tables differ from what the manifest declares, the migrations between two versions, and
 * the one batch that brings the database to the new version, with the token change, the tools, the
 * problems and the record to write. Pure: the CLI reads the database (list_tables, describe_table,
 * describe_database) and passes what it read; nothing here reads or writes anything.
 */

import { ColumnBinder } from "./extension-columns.js";
import { bindRoles, compareVersions, EXT_DOCS, rolesNamed, satisfiesEngine } from "./extension-manifest.js";
import type { ExtensionManifest, ManifestColumn, ManifestTable } from "./extension-manifest.js";
import type { ExtensionSourceRecord, InstalledExtension, RecordTable } from "./extension-record.js";
import { didYouMean } from "./guidance.js";

// --- types ------------------------------------------------------------------------------------------

/** What list_tables answered, with the database's default catalog. */
export interface TablesListing {
  default_catalog: string;
  tables: { qualified: string; name: string; catalog: string; schema: string; aliases?: string[]; tags?: Record<string, string> }[];
  views: { qualified: string }[];
}

/** The user's choices, from the options of the command. */
export interface InstallChoices {
  /** role → qualified table (`--map role=catalog.schema.table`). */
  map: Record<string, string>;
  /** role → (manifest column → the user's column) (`--map role.column=column`). */
  columns: Record<string, Record<string, string>>;
  /** Dependency roles to create (`--create`). */
  create: string[];
  /** role → manifest columns to add to the matched dependency table (`--add role.column`). */
  add: Record<string, string[]>;
  /** Catalog of created tables and views (`--catalog`; default: the database's default catalog). */
  catalog?: string;
  /** Schema of created owned tables and views (`--schema`; default: the manifest's default_schema). */
  schema?: string;
}

export type TableDecision = "create" | "adopt" | "match" | "unresolved";

/** The table chosen for one role. */
export interface TableChoice {
  role: string;
  owned: boolean;
  table: string | null;
  decision: TableDecision;
  /** True when the installer chose it, not the user: the agent must confirm it with the user. */
  proposed: boolean;
  candidates: string[];
}

export type ProblemCode =
  | "engine_too_old"
  | "unknown_role"
  | "table_not_found"
  | "table_missing"
  | "table_exists"
  | "owned_create"
  | "ambiguous_dependency"
  | "missing_column"
  | "column_differs"
  | "owned_column_map"
  | "column_map_unsupported"
  | "migration_conflict"
  | "base_differs"
  | "view_exists"
  | "tool_name_taken"
  | "token_exists"
  | "too_many_operations"
  | "already_installed"
  | "downgrade"
  | "same_version";

/** Something that keeps the plan from being written: what is wrong, how to fix it, where to read more. */
export interface PlanProblem {
  code: ProblemCode;
  role?: string;
  table?: string;
  column?: string;
  detail: string;
  hint: string;
  docs: string;
}

/** What describe_table answered for an existing table. */
export interface DescribedTable {
  qualified: string;
  columns: Record<string, unknown>[];
  constraints?: Record<string, Record<string, unknown>>;
  constraint_hints?: Record<string, string>;
  instructions?: string;
  bases?: string[];
  tags?: Record<string, string>;
}

export interface PlanInput {
  manifest: ExtensionManifest;
  /** What was fetched: the label the user reads, the source record, the commit and the hashes. */
  source: { label: string; record: ExtensionSourceRecord; commit: string; manifest_sha256: string; entry_sha256: string };
  engineVersion: string;
  listing: TablesListing;
  chosen: TableChoice[];
  choiceProblems: PlanProblem[];
  /** describe_table answers, by qualified name, for every bound existing table. */
  described: Record<string, DescribedTable>;
  /** describe_database bases. */
  bases: { name: string; columns: string[] }[];
  choices: InstallChoices;
  /** Names of the named tokens (/tokens/). */
  tokens: string[];
  /** The record of this extension, when installed. */
  installed: InstalledExtension | null;
  /** install: null; a repair: the fetched manifest itself (null is read as it); update: the installed version's manifest. */
  oldManifest: ExtensionManifest | null;
  /** The other installed extensions (their tool names). */
  others: InstalledExtension[];
  /** Engine operations and docs tools (the CLI passes OPERATIONS names + DOCS_TOOL_NAMES). */
  reservedTools: string[];
  /** Whether this machine holds the extension's token file. */
  localTokenPresent: boolean;
  /** ISO time for the record's dates. */
  now: string;
}

export interface PlanTable {
  role: string;
  owned: boolean;
  table: string | null;
  decision: TableDecision;
  proposed: boolean;
  candidates: string[];
  /** Human lines: "create", "add column repo", "replace CHECK run_has_executor", "set instructions", "add tags". */
  changes: string[];
  columns: Record<string, string>;
  absent: string[];
}

export interface PlanTool {
  name: string;
  read_only: boolean;
  /** Qualified names of the tables it writes. */
  writes: string[];
  change: "added" | "removed" | "changed" | "same";
}

export interface ExtensionPlan {
  action: "install" | "repair" | "update";
  extension: { name: string; version: string; description: string; from_version: string | null; source: string; commit: string };
  tables: PlanTable[];
  /** The batch, each `{ op, ...arguments }`, in order (empty: nothing to write). */
  operations: Record<string, unknown>[];
  token: { name: string; action: "create" | "rotate" | "update" | "keep"; write: string[]; previous_write: string[] | null };
  tools: PlanTool[];
  problems: PlanProblem[];
  notes: string[];
  ready: boolean;
  agent_message: string;
  summary: string;
  /** The record to write after the batch (`migration_id` filled by the CLI); null when not ready. */
  record: InstalledExtension | null;
}

/** The text every plan ends with, for the agent that runs the installer. */
export const AGENT_MESSAGE =
  'For the agent installing this extension: show this plan to the user before anything is written. Where a table says "proposed", the installer chose it: ask the user to confirm it, to pick another table (--map <role>=<catalog.schema.table>, --map <role>.<column>=<column>), or to create it (--create <role>). Add a missing column only after the user agrees (--add <role>.<column>). Solve each problem the same way. Then run the same command again with the user\'s choices and --yes, only once the user approved the tables it creates or changes, the tools and the token\'s permissions.';

/** Keys under a filter or a query name columns; elsewhere in a migration step they are parameters. */
const FILTER_KEYS = new Set(["check", "where", "ref_where", "query", "on"]);

/** The most operations one batch takes. */
export const MAX_OPERATIONS = 200;

// --- helpers ----------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
type Op = Obj & { op: string };

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObject(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** JSON with object keys sorted at every level: equal values give equal texts. */
function stable(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (isObject(x)) {
      const out: Obj = {};
      for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

/** A column spec as the engine takes it: the manifest's `need` removed. */
function spec(c: ManifestColumn): Obj {
  const { need: _need, ...rest } = c;
  return rest;
}

const tableName = (t: ManifestTable, role: string): string => t.name ?? role;

function problem(code: ProblemCode, detail: string, hint: string, docs: string, where: { role?: string; table?: string; column?: string } = {}): PlanProblem {
  return { code, ...where, detail, hint, docs };
}

/** `<type>` or `list of <items>`, then ` → <ref>` for a link. */
function typeDescription(c: Obj, ownTable: string): string {
  const type = c.type === "list" ? `list of ${String(c.items)}` : String(c.type);
  return isLink(c) ? `${type} → ${c.ref === "self" ? ownTable : String(c.ref)}` : type;
}

const isLink = (c: Obj): boolean => c.type === "link" || (c.type === "list" && c.items === "link");

/**
 * How an existing column differs from what the manifest expects, in a few words (null: it fits).
 * `ref: "self"` means `ownTable` on both sides. `strict` also compares hierarchy, acyclic and inverse
 * (the extension's own tables); other attributes never count.
 */
export function columnDifference(expected: Record<string, unknown>, actual: Record<string, unknown>, ownTable: string, strict: boolean): string | null {
  const norm = (ref: unknown): string => (ref === "self" ? ownTable : String(ref));
  if (expected.type !== actual.type) return `is ${String(actual.type)}, not ${String(expected.type)}`;
  if (expected.type === "list" && expected.items !== actual.items) return `holds ${String(actual.items)}, not ${String(expected.items)}`;
  if (isLink(expected) && norm(actual.ref) !== norm(expected.ref)) return `links to ${norm(actual.ref)}, not ${norm(expected.ref)}`;
  if (expected.type === "enum") {
    const have = list(actual.values);
    const missing = list(expected.values).filter((v) => !have.includes(v));
    if (missing.length > 0) return `lacks the values ${missing.map(String).join(", ")}`;
  }
  if (strict) {
    for (const k of ["hierarchy", "acyclic"]) if (expected[k] === true && actual[k] !== true) return `has no ${k}: true`;
    if (expected.inverse !== undefined && actual.inverse !== expected.inverse) return `has inverse ${actual.inverse === undefined ? "none" : String(actual.inverse)}, not ${String(expected.inverse)}`;
  }
  return null;
}

// --- choosing the tables ----------------------------------------------------------------------------

/** The table of every role of the manifest, from the user's choices, the installed record and the listing. */
export function chooseTables(m: ExtensionManifest, listing: TablesListing, choices: InstallChoices, installed: InstalledExtension | null): { chosen: TableChoice[]; problems: PlanProblem[] } {
  const catalog = choices.catalog ?? listing.default_catalog;
  const problems: PlanProblem[] = [];
  const roles = m.roles;
  const qualified = listing.tables.map((t) => t.qualified);
  const exists = (q: string): boolean => qualified.includes(q);

  const known = (option: string, role: string): boolean => {
    if (roles.includes(role)) return true;
    const near = didYouMean(role, roles);
    problems.push(problem("unknown_role", `${option} names the role "${role}", which the extension does not have`, `The roles are ${roles.join(", ")}.${near ? ` ${near}` : ""}`, EXT_DOCS.tables, { role }));
    return false;
  };
  const ownedColumns = (option: string, role: string, columns: string[]): void => {
    if (!known(option, role) || !m.tables[role]!.owned) return;
    for (const c of columns) {
      problems.push(
        problem("owned_column_map", `${role}: the columns of the extension's own table keep the extension's names`, `Leave --map ${role}.${c} and --add ${role}.${c} out.`, EXT_DOCS.tables, { role, column: c }),
      );
    }
  };
  for (const role of Object.keys(choices.map)) known("--map", role);
  for (const role of Object.keys(choices.columns)) ownedColumns("--map", role, Object.keys(choices.columns[role]!));
  for (const role of choices.create) known("--create", role);
  for (const role of Object.keys(choices.add)) ownedColumns("--add", role, choices.add[role]!);

  const chosen = roles.map((role): TableChoice => {
    const t = m.tables[role]!;
    const owned = t.owned;
    const name = tableName(t, role);
    const pick = (table: string | null, decision: TableDecision, proposed = false, candidates: string[] = []): TableChoice => ({ role, owned, table, decision, proposed, candidates });
    const mapped = choices.map[role];
    if (mapped !== undefined) {
      if (exists(mapped)) return pick(mapped, owned ? "adopt" : "match");
      const near = didYouMean(mapped, qualified);
      problems.push(problem("table_not_found", `${role}: no table ${mapped}`, `Pass a qualified name (catalog.schema.table): list_tables lists them.${near ? ` ${near}` : ""}`, EXT_DOCS.tables, { role, table: mapped }));
      return pick(null, "unresolved");
    }
    const recorded = installed?.tables[role];
    if (recorded) {
      if (exists(recorded.table)) return pick(recorded.table, owned ? "adopt" : "match");
      problems.push(
        problem("table_missing", `${role}: the table ${recorded.table} the extension uses is gone`, `Restore it (restore_table), or remove the extension: datanotes extension remove ${m.name}.`, EXT_DOCS.update, {
          role,
          table: recorded.table,
        }),
      );
      return pick(null, "unresolved");
    }
    if (choices.create.includes(role)) {
      if (owned) {
        problems.push(
          problem("owned_create", `${role}: the extension creates or adopts its own tables; --create is for the tables it depends on`, `Leave ${role} out of --create; --map ${role}=<table> adopts an existing table.`, EXT_DOCS.tables, { role }),
        );
        return pick(null, "unresolved");
      }
      const target = `${catalog}.${t.schema ?? "public"}.${name}`;
      if (!exists(target)) return pick(target, "create");
      problems.push(problem("table_exists", `${role}: ${target} exists already`, `Use it with --map ${role}=${target}, or create the table in another catalog with --catalog.`, EXT_DOCS.tables, { role, table: target }));
      return pick(null, "unresolved");
    }
    if (owned) {
      const target = `${catalog}.${choices.schema ?? t.schema ?? m.default_schema}.${name}`;
      return exists(target) ? pick(target, "adopt", true) : pick(target, "create");
    }
    const names = (t.names ?? [name]).map((n) => n.toLowerCase());
    const candidates = listing.tables
      .filter((x) => names.includes(x.name.toLowerCase()) || (x.aliases ?? []).some((a) => names.includes(a.toLowerCase())))
      .map((x) => x.qualified)
      .sort();
    if (candidates.length === 1) return pick(candidates[0]!, "match", true, candidates);
    if (candidates.length === 0) return pick(`${catalog}.${t.schema ?? "public"}.${name}`, "create", true);
    problems.push(
      problem("ambiguous_dependency", `${role}: ${candidates.length} tables could be it: ${candidates.join(", ")}`, `Ask the user which one, then pass --map ${role}=<table>, or --create ${role} for a new table.`, EXT_DOCS.tables, { role }),
    );
    return pick(null, "unresolved", false, candidates);
  });
  return { chosen, problems };
}

// --- the plan ---------------------------------------------------------------------------------------

interface ModelTable {
  columns: Map<string, Obj>;
  constraints: Map<string, { check: unknown; hint: string | undefined }>;
  instructions: string | undefined;
  bases: string[];
  tags: Record<string, unknown>;
}

function modelTable(d: DescribedTable): ModelTable {
  const hints = d.constraint_hints ?? {};
  const constraints = new Map<string, { check: unknown; hint: string | undefined }>();
  for (const [n, check] of Object.entries(d.constraints ?? {})) constraints.set(n, { check, hint: hints[n] });
  return {
    columns: new Map(d.columns.map((c) => [String(c.name), c])),
    constraints,
    instructions: d.instructions,
    bases: [...(d.bases ?? [])],
    tags: { ...(d.tags ?? {}) },
  };
}

/** Compute the plan of an install, a repair or an update from what the CLI read. */
export function planChanges(input: PlanInput): ExtensionPlan {
  const m = input.manifest;
  const name = m.name;
  const tokenName = `ext-${name}`;
  const { installed, source, choices } = input;
  const catalog = choices.catalog ?? input.listing.default_catalog;
  const viewSchema = choices.schema ?? m.default_schema;
  const notes: string[] = [];
  const operations: Op[] = [];
  /** The installed record's tables (none for a first install). */
  const recorded: Record<string, RecordTable> = installed ? installed.tables : {};

  // 1. action
  const actionProblems: PlanProblem[] = [];
  let action: ExtensionPlan["action"];
  if (installed === null) action = "install";
  else if (installed.version === m.version && installed.commit === source.commit) action = "repair";
  else if (input.oldManifest === null) {
    action = "install";
    actionProblems.push(problem("already_installed", `${name} ${installed.version} is installed`, `Update it instead: datanotes extension update ${name} --to <ref> (or --from <source>).`, EXT_DOCS.update));
  } else {
    action = "update";
    const order = compareVersions(m.version, installed.version);
    if (order < 0) {
      actionProblems.push(
        problem("downgrade", `${m.version} is older than the installed ${installed.version}`, `Undo the last update with datanotes extension rollback ${name}; installing an older version is not supported.`, EXT_DOCS.rollback),
      );
    } else if (order === 0 && source.record.kind !== "local" && !/^[0-9a-f]{40}$/.test(source.record.ref ?? "")) {
      actionProblems.push(
        problem(
          "same_version",
          `${installed.version} is installed from commit ${installed.commit}; ${source.record.ref ?? source.label} now names commit ${source.commit}`,
          `A version tag that moved is a warning sign: check the repository. To install that commit anyway, pass its id: --to ${source.commit}.`,
          EXT_DOCS.update,
        ),
      );
    }
  }
  // a repair reinstalls the fetched version itself: its old manifest is the fetched one, also when none was given
  const oldManifest: ExtensionManifest | null = action === "repair" ? (input.oldManifest ?? m) : input.oldManifest;

  // 2. engine
  const engineProblems: PlanProblem[] = [];
  if (!satisfiesEngine(m.datanotes, input.engineVersion)) {
    engineProblems.push(
      problem(
        "engine_too_old",
        `the extension needs Datanotes ${m.datanotes}; the engine is ${input.engineVersion}`,
        "Update the engine to a version the extension supports and start it again, or install an older version of the extension.",
        EXT_DOCS.install,
      ),
    );
  }

  // 3. bindings (an unresolved role keeps its @role text: the plan is not ready anyway)
  const choiceOf = new Map(input.chosen.map((c) => [c.role, c]));
  const tables: Record<string, string> = {};
  for (const role of m.roles) tables[role] = choiceOf.get(role)?.table ?? `@${role}`;
  const bind = <T>(v: T): T => bindRoles(v, tables);
  const existing = (c: TableChoice): boolean => c.decision === "adopt" || c.decision === "match";
  // column bindings of the matched dependencies: the installed record's, then the user's choices
  const columnMap: Record<string, Record<string, string>> = {};
  for (const c of input.chosen) if (!c.owned && c.decision === "match") columnMap[c.role] = { ...(recorded[c.role]?.columns ?? {}), ...(choices.columns[c.role] ?? {}) };
  const binder = new ColumnBinder(m, columnMap);
  /** A manifest column of `role` as the engine takes it: its links bound, the columns it names bound. */
  const bindColumn = (role: string, c: ManifestColumn): Obj => bind(spec(binder.column(role, c)));

  // 4. model
  const model = new Map<string, ModelTable>();
  for (const c of input.chosen) if (existing(c)) model.set(c.table!, modelTable(input.described[c.table!] ?? { qualified: c.table!, columns: [] }));
  const views = new Set(input.listing.views.map((v) => v.qualified));
  const bases = new Map(input.bases.map((b) => [b.name, [...b.columns]]));

  const planTables: PlanTable[] = input.chosen.map((c) => ({ ...c, candidates: [...c.candidates], changes: [], columns: {}, absent: [] }));
  const planOf = new Map(planTables.map((t) => [t.role, t]));

  // 5. migrations
  const migrationProblems: PlanProblem[] = [];
  if (action === "update") {
    const from = installed!.version;
    for (const g of m.migrations) {
      if (compareVersions(g.version, from) <= 0 || compareVersions(g.version, m.version) > 0) continue;
      for (const raw of g.operations) {
        const named = rolesNamed(raw).map((r) => choiceOf.get(r)!);
        if (named.some((c) => c.decision === "unresolved")) continue;
        const fresh = named.find((c) => !existing(c));
        if (fresh) {
          migrationProblems.push(
            problem(
              "migration_conflict",
              `migration ${g.version}: ${raw.op} on ${fresh.table}: ${fresh.role} is new in this version: a migration may only change the tables of the installed version`,
              "Make the table match what the migration expects (describe_table shows it), or ask the extension's author.",
              EXT_DOCS.update,
              { role: fresh.role, table: fresh.table! },
            ),
          );
          continue;
        }
        const touched = mappedNamed(raw);
        if (touched !== null) {
          migrationProblems.push(
            problem(
              "migration_conflict",
              `migration ${g.version}: ${raw.op} names column ${touched.column} of ${touched.role}, which reads your column ${binder.name(touched.role, touched.column)}`,
              `Rename your column to ${touched.column} with rename_column and run the command again without --map ${touched.role}.${touched.column}, or ask the extension's author.`,
              EXT_DOCS.update,
              { role: touched.role, column: touched.column },
            ),
          );
          continue;
        }
        const op = bind(raw) as Op;
        const r = simulate(op, g.version);
        if (typeof r === "string") {
          // only the steps on a table conflict
          const table = String(op.table);
          migrationProblems.push(
            problem("migration_conflict", `migration ${g.version}: ${raw.op} on ${table}: ${r}`, "Make the table match what the migration expects (describe_table shows it), or ask the extension's author.", EXT_DOCS.update, { table }),
          );
        } else if (r !== null) operations.push(r);
      }
    }
  }

  /** The first mapped dependency column a migration step names, or null: migrations are not rewritten, so such a step is refused. */
  function mappedNamed(raw: Obj): { role: string; column: string } | null {
    return binder.named(raw, rolesNamed(raw), (k, inKeys) => inKeys || FILTER_KEYS.has(k))[0] ?? null;
  }

  /** Fills catalog and schema of a create_table or create_view, as the model reads them. */
  function qualify(op: Obj): string {
    return `${String(op.catalog ?? catalog)}.${String(op.schema ?? viewSchema)}.${String(op.name)}`;
  }

  /** Apply one migration step to the model: the step to keep, null to skip it, or the conflict's text. */
  function simulate(op: Op, version: string): Op | null | string {
    const table = String(op.table);
    const t = model.get(table);
    const needsTable = ["add_column", "rename_column", "alter_column", "add_constraint", "alter_table", "set_table_bases"];
    if (needsTable.includes(op.op) && !t) return "no such table";
    switch (op.op) {
      case "create_table": {
        const q = qualify(op);
        if (model.has(q)) {
          notes.push(`migration ${version}: skips create_table ${q}: the table exists`);
          return null;
        }
        model.set(q, modelTable({ qualified: q, columns: list(op.columns).map(obj) }));
        const [cat, schema] = q.split(".");
        return { ...op, catalog: cat, schema };
      }
      case "drop_table":
        return model.delete(table) ? op : null;
      case "add_column": {
        const col = obj(op.column);
        const c = String(col.name);
        const actual = t!.columns.get(c);
        if (actual) {
          const d = columnDifference(col, actual, table, true);
          if (d !== null) return `column ${c} exists with another definition: ${d}`;
          notes.push(`migration ${version}: skips add_column ${c}: the column exists`);
          return null;
        }
        t!.columns.set(c, col);
        return op;
      }
      case "drop_column":
        return t?.columns.delete(String(op.column)) ? op : null;
      case "rename_column": {
        const from = String(op.from_column);
        const to = String(op.to_column);
        const hasFrom = t!.columns.has(from);
        const hasTo = t!.columns.has(to);
        if (hasFrom && hasTo) return `both ${from} and ${to} exist`;
        if (hasTo) return null;
        if (!hasFrom) return `no column ${from}`;
        t!.columns.set(to, { ...t!.columns.get(from)!, name: to });
        t!.columns.delete(from);
        return op;
      }
      case "alter_column": {
        const c = String(op.column);
        const actual = t!.columns.get(c);
        if (!actual) return `no column ${c}`;
        const changed = { ...actual, ...obj(op.changes) };
        t!.columns.delete(c);
        t!.columns.set(String(changed.name), changed);
        return op;
      }
      case "add_constraint": {
        const n = String(op.name);
        const hint = typeof op.hint === "string" ? op.hint : undefined;
        const actual = t!.constraints.get(n);
        if (actual) {
          if (stable(actual.check) === stable(op.check) && actual.hint === hint) return null;
          return `CHECK ${n} exists with another definition`;
        }
        t!.constraints.set(n, { check: op.check, hint });
        return op;
      }
      case "drop_constraint":
        return t?.constraints.delete(String(op.name)) ? op : null;
      case "alter_table": {
        if (typeof op.instructions === "string") t!.instructions = op.instructions;
        for (const [k, v] of Object.entries(obj(op.tags))) {
          if (v === null) delete t!.tags[k];
          else t!.tags[k] = v;
        }
        return op;
      }
      case "set_table_bases":
        t!.bases = list(op.bases).map(String);
        return op;
      case "define_base":
        bases.set(String(op.name), list(op.columns).map((c) => String(obj(c).name)));
        return op;
      case "create_view": {
        const q = qualify(op);
        if (views.has(q) && op.replace !== true) return null;
        views.add(q);
        const [cat, schema] = q.split(".");
        return { ...op, catalog: cat, schema };
      }
      case "drop_view":
        return views.delete(String(op.view)) ? op : null;
      default:
        return op;
    }
  }

  // 6. reconcile
  const reconcileProblems: PlanProblem[] = [];
  const ownedPlans = planTables.filter((t) => t.owned && t.decision !== "unresolved");

  // 6.1 bases
  for (const b of Object.keys(m.bases)) {
    const def = m.bases[b]!;
    const have = bases.get(b);
    const define = (): void => {
      operations.push({ op: "define_base", name: b, description: def.description, columns: bind(def.columns.map(spec)) });
      bases.set(b, def.columns.map((c) => c.name));
      for (const t of ownedPlans) if ((m.tables[t.role]!.bases ?? []).includes(b)) t.changes.push(`define base ${b}`);
    };
    if (!have) {
      define();
      continue;
    }
    const lacking = def.columns.map((c) => c.name).filter((c) => !have.includes(c));
    if (lacking.length === 0) continue;
    if (action !== "update") {
      reconcileProblems.push(
        problem("base_differs", `base ${b} exists without the columns ${lacking.join(", ")}`, "Rename your base, or add those columns to it with define_base, then run the command again.", EXT_DOCS.install),
      );
    } else if (oldManifest!.bases[b] !== undefined && stable(oldManifest!.bases[b]) !== stable(def)) define();
  }

  // 6.2 dependency roles
  for (const t of planTables) {
    if (t.owned || t.decision === "unresolved") continue;
    const role = t.role;
    const def = m.tables[role]!;
    const q = t.table!;
    if (t.decision === "create") {
      const [cat, schema, tname] = q.split(".");
      operations.push({
        op: "create_table",
        catalog: cat,
        schema,
        name: tname,
        description: def.description,
        columns: def.columns.map((c) => bindColumn(role, c)),
        ...(def.filename !== undefined ? { filename: def.filename } : {}),
        ...(def.aliases !== undefined ? { aliases: def.aliases } : {}),
      });
      t.changes.push("create");
      continue;
    }
    const actualCols = model.get(q)!.columns;
    for (const c of def.columns) {
      const bound = bindColumn(role, c);
      const actualName = binder.name(role, c.name);
      const actual = actualCols.get(actualName);
      if (actual) {
        const diff = columnDifference(bound, actual, q, false);
        if (diff !== null && c.need === "required") {
          reconcileProblems.push(
            problem("column_differs", `${role}: column ${actualName} of ${q} ${diff}`, `Map another column (--map ${role}.${c.name}=<column>), or another table (--map ${role}=<table>).`, EXT_DOCS.tables, {
              role,
              table: q,
              column: actualName,
            }),
          );
        } else if (diff !== null) notes.push(`${role}: column ${actualName} ${diff}: the extension reads it as it is`);
      } else if ((choices.add[role] ?? []).includes(c.name)) {
        operations.push({ op: "add_column", table: q, column: { ...bound, name: actualName } });
        t.changes.push(`add column ${actualName}`);
      } else if (c.need === "required") {
        reconcileProblems.push(
          problem(
            "missing_column",
            `${role}: ${q} has no column ${c.name} (${typeDescription(bound, q)})`,
            `Map the column that holds it (--map ${role}.${c.name}=<column>), or add it (--add ${role}.${c.name}) once the user agrees.`,
            EXT_DOCS.tables,
            { role, table: q, column: c.name },
          ),
        );
        continue;
      } else {
        t.absent.push(c.name);
        notes.push(`${role}: ${q} has no column ${c.name}: the extension works without it`);
        continue;
      }
      if (actualName !== c.name) t.columns[c.name] = actualName;
    }
  }

  // 6.3 owned roles
  for (const t of ownedPlans) {
    const role = t.role;
    const def = m.tables[role]!;
    const q = t.table!;
    const tags = { extension: name, extension_role: role };
    const instructions = def.instructions === undefined ? undefined : bind(def.instructions);
    const constraint = (c: { name: string; check: Record<string, unknown>; hint: string }): Op => ({ op: "add_constraint", table: q, name: c.name, check: bind(binder.where(role, c.check)), hint: c.hint });
    if (t.decision === "create") {
      const [cat, schema, tname] = q.split(".");
      operations.push({
        op: "create_table",
        catalog: cat,
        schema,
        name: tname,
        description: def.description,
        columns: def.columns.map((c) => bindColumn(role, c)),
        ...(def.filename !== undefined ? { filename: def.filename } : {}),
        ...(def.aliases !== undefined ? { aliases: def.aliases } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
        tags,
      });
      if ((def.bases ?? []).length > 0) operations.push({ op: "set_table_bases", table: q, bases: def.bases });
      for (const c of def.constraints ?? []) operations.push(constraint(c));
      t.changes.unshift("create");
      continue;
    }
    const mt = model.get(q)!;
    // (a) columns
    for (const c of def.columns) {
      const bound = bindColumn(role, c);
      const actual = mt.columns.get(c.name);
      if (!actual) {
        operations.push({ op: "add_column", table: q, column: bound });
        t.changes.push(`add column ${c.name}`);
        continue;
      }
      const diff = columnDifference(bound, actual, q, true);
      if (diff !== null && c.need === "required") {
        reconcileProblems.push(
          problem("column_differs", `${role}: column ${c.name} of ${q} ${diff}`, `Change the column with alter_column, or install on another table: --map ${role}=<table>.`, EXT_DOCS.tables, { role, table: q, column: c.name }),
        );
      } else if (diff !== null) notes.push(`${role}: column ${c.name} ${diff}: kept as it is`);
    }
    // (b) bases
    const missingBases = (def.bases ?? []).filter((b) => !mt.bases.includes(b));
    if (missingBases.length > 0) {
      operations.push({ op: "set_table_bases", table: q, bases: [...mt.bases, ...missingBases] });
      for (const b of missingBases) t.changes.push(`add base ${b}`);
    }
    // (c) CHECKs
    for (const c of def.constraints ?? []) {
      const actual = mt.constraints.get(c.name);
      if (!actual) {
        operations.push(constraint(c));
        t.changes.push(`add CHECK ${c.name}`);
      } else if (stable(actual.check) !== stable(bind(binder.where(role, c.check))) || actual.hint !== c.hint) {
        operations.push({ op: "drop_constraint", table: q, name: c.name }, constraint(c));
        t.changes.push(`replace CHECK ${c.name}`);
      }
    }
    if (action === "update") {
      const keep = new Set((def.constraints ?? []).map((c) => c.name));
      for (const c of oldManifest!.tables[role]?.constraints ?? []) {
        if (keep.has(c.name) || !mt.constraints.has(c.name)) continue;
        operations.push({ op: "drop_constraint", table: q, name: c.name });
        t.changes.push(`drop CHECK ${c.name}`);
      }
    }
    // (d) instructions and tags
    const alter: Op = { op: "alter_table", table: q };
    if (instructions !== undefined && (mt.instructions ?? "").trimEnd() !== instructions.trimEnd()) {
      alter.instructions = instructions;
      t.changes.push("set instructions");
    }
    if (mt.tags.extension !== name || mt.tags.extension_role !== role) {
      alter.tags = tags;
      t.changes.push("add tags");
    }
    if (Object.keys(alter).length > 2) operations.push(alter);
  }

  // 6.4 views
  const viewPlan = planTables.find((t) => t.owned) ?? planTables[0]!;
  for (const v of Object.keys(m.views)) {
    const def = m.views[v]!;
    const q = `${catalog}.${viewSchema}.${v}`;
    const query = binder.query(v, def.query);
    const create: Op = {
      op: "create_view",
      catalog,
      schema: viewSchema,
      name: v,
      description: def.description,
      query: bind(query),
      ...(def.aliases !== undefined ? { aliases: def.aliases } : {}),
      ...(def.labels !== undefined ? { labels: def.labels } : {}),
    };
    if (!views.has(q)) {
      operations.push(create);
      viewPlan.changes.push(`create view ${v}`);
    } else if (action === "install") {
      reconcileProblems.push(problem("view_exists", `${q} exists already`, "Drop or rename that view (drop_view), or install with --schema <another schema>.", EXT_DOCS.install, { table: q }));
    } else if (stable(oldManifest!.views[v]) !== stable(def) || stable(query) !== stable(def.query)) {
      // a view that reads a mapped column is replaced too: up to 3.4.1 it kept the manifest's names
      operations.push({ ...create, replace: true });
      viewPlan.changes.push(`replace view ${v}`);
    }
  }
  if (action === "update") {
    for (const v of Object.keys(oldManifest!.views)) {
      const q = `${catalog}.${viewSchema}.${v}`;
      if (m.views[v] !== undefined || !views.has(q)) continue;
      operations.push({ op: "drop_view", view: q });
      viewPlan.changes.push(`drop view ${v}`);
    }
    // 6.5 roles no longer used
    for (const [role, rt] of Object.entries(recorded)) {
      if (m.tables[role] === undefined) notes.push(`${role} (${rt.table}) is no longer used by the extension: it stays in the database`);
    }
  }

  // 6.6 what the column bindings could not rewrite
  const seen = new Set<string>();
  for (const i of binder.issues) {
    const key = `${i.role}.${i.column}.${i.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reconcileProblems.push(
      problem(
        "column_map_unsupported",
        `${i.role}: ${i.where} names column ${i.column}, which reads your column ${binder.name(i.role, i.column)}: the installer cannot rewrite it there`,
        `Rename your column to ${i.column} with rename_column and leave --map ${i.role}.${i.column} out, or ask the extension's author.`,
        EXT_DOCS.tables,
        { role: i.role, column: i.column },
      ),
    );
  }

  // 7. tools
  const toolProblems: PlanProblem[] = [];
  const others = input.others.filter((o) => o.name !== name);
  const boundNames = (roles: string[]): string[] => roles.map((r) => tables[r]!);
  /** The tables an old tool wrote, from the installed record. */
  const recordedNames = (roles: string[]): string[] => roles.filter((r) => recorded[r] !== undefined).map((r) => recorded[r]!.table);
  const tools: PlanTool[] = m.tools.map((tool) => {
    if (input.reservedTools.includes(tool.name)) {
      toolProblems.push(toolTaken(`tool ${tool.name} is also a tool of the MCP server`));
    }
    for (const o of others) if (o.tools.includes(tool.name)) toolProblems.push(toolTaken(`tool ${tool.name} is also a tool of extension ${o.name}`));
    const old = oldManifest?.tools.find((x) => x.name === tool.name);
    const writes = boundNames(tool.writes);
    let change: PlanTool["change"] = "added";
    if (old) {
      const shape = (x: typeof tool, w: string[]): string => stable({ description: x.description, inputSchema: x.inputSchema, annotations: x.annotations, writes: w });
      change = shape(old, recordedNames(old.writes)) === shape(tool, writes) ? "same" : "changed";
    }
    return { name: tool.name, read_only: tool.annotations.readOnlyHint === true, writes, change };
  });
  if (action === "update") {
    for (const old of oldManifest!.tools) {
      if (m.tools.some((x) => x.name === old.name)) continue;
      tools.push({ name: old.name, read_only: old.annotations.readOnlyHint === true, writes: recordedNames(old.writes), change: "removed" });
    }
  }

  // 8. token
  const tokenProblems: PlanProblem[] = [];
  const write = [...new Set(boundNames(m.permissions.write))].sort();
  let tokenAction: ExtensionPlan["token"]["action"] = "create";
  const tokenKnown = input.tokens.includes(tokenName);
  if (action === "install") {
    if (tokenKnown) {
      tokenProblems.push(
        problem("token_exists", `a token named ${tokenName} exists already`, `Delete it (POST /datanotes/tokens/delete/), or run datanotes extension remove ${name} to clear what an earlier install left.`, EXT_DOCS.remove),
      );
    }
  } else if (tokenKnown) {
    if (!input.localTokenPresent) tokenAction = "rotate";
    else tokenAction = stable(write) === stable([...installed!.write].sort()) ? "keep" : "update";
  }

  // 9. size
  const sizeProblems: PlanProblem[] = [];
  if (operations.length > MAX_OPERATIONS) {
    sizeProblems.push(
      problem(
        "too_many_operations",
        `the plan needs ${operations.length} operations; a batch takes ${MAX_OPERATIONS}`,
        "Install on tables that need fewer changes, or ask the extension's author to split the migration.",
        EXT_DOCS.install,
      ),
    );
  }

  // 10. result
  const problems = [...input.choiceProblems, ...actionProblems, ...engineProblems, ...migrationProblems, ...reconcileProblems, ...toolProblems, ...tokenProblems, ...sizeProblems];
  const ready = problems.length === 0;
  const count = (d: TableDecision): number => planTables.filter((t) => t.decision === d).length;
  const summary = ready
    ? `${name} ${m.version}: ${count("create")} created, ${count("adopt")} adopted, ${count("match")} matched; ${operations.length > 0 ? `${operations.length} operations in one batch` : "nothing to write"}`
    : `${name} ${m.version}: ${problems.length} problem${problems.length === 1 ? "" : "s"}: nothing written`;
  const recordTables: Record<string, RecordTable> = {};
  for (const t of planTables) {
    recordTables[t.role] = {
      table: t.table!,
      owned: t.owned,
      ...(Object.keys(t.columns).length > 0 ? { columns: { ...t.columns } } : {}),
      ...(t.absent.length > 0 ? { absent: [...t.absent] } : {}),
    };
  }
  const record: InstalledExtension | null = ready
    ? {
        name,
        version: m.version,
        description: m.description,
        api: m.api,
        source: source.record,
        commit: source.commit,
        manifest_sha256: source.manifest_sha256,
        entry_sha256: source.entry_sha256,
        token: tokenName,
        tables: recordTables,
        tools: m.tools.map((t) => t.name),
        write,
        migration_id: null,
        installed_at: installed?.installed_at ?? input.now,
        updated_at: input.now,
        previous: installed,
      }
    : null;

  return {
    action,
    extension: { name, version: m.version, description: m.description, from_version: action === "update" ? installed!.version : null, source: source.label, commit: source.commit },
    tables: planTables,
    operations,
    token: { name: tokenName, action: tokenAction, write, previous_write: installed?.write ?? null },
    tools,
    problems,
    notes,
    ready,
    agent_message: AGENT_MESSAGE,
    summary,
    record,
  };
}

function toolTaken(detail: string): PlanProblem {
  return problem("tool_name_taken", detail, "Two tools cannot share a name: ask the extension's author to rename it, or remove the other extension first.", EXT_DOCS.permissions);
}

// --- the text ---------------------------------------------------------------------------------------

/** The plan as the user reads it in a terminal. */
export function renderPlan(plan: ExtensionPlan): string {
  const e = plan.extension;
  const verb = { install: "Install", repair: "Repair", update: "Update" }[plan.action];
  const writes = (w: string[]): string => (w.length > 0 ? `writes ${w.join(", ")}` : "writes nothing");
  const lines = [`${verb} ${e.name} ${e.version}${e.from_version !== null ? ` (from ${e.from_version})` : ""}: ${e.description}`, `Source: ${e.source} (commit ${e.commit.slice(0, 12)})`, "", "Tables:"];
  for (const t of plan.tables) {
    lines.push(`  ${t.role}  ${t.table ?? "?"}  ${t.decision}${t.proposed ? " (proposed)" : ""}${t.changes.length > 0 ? `: ${t.changes.join("; ")}` : ""}`);
  }
  lines.push(`Tools (${plan.tools.length}):`);
  for (const t of plan.tools) {
    lines.push(`  ${t.name}  ${t.writes.length > 0 ? writes(t.writes) : "reads"}${plan.action === "update" && t.change !== "same" ? `  (${t.change})` : ""}`);
  }
  lines.push(`Token: ${plan.token.name}, ${plan.token.action}, ${writes(plan.token.write)} (no schema changes)`);
  lines.push(plan.operations.length > 0 ? `Operations: ${plan.operations.length} in one batch (one undo_migration)` : "Operations: none");
  if (plan.notes.length > 0) lines.push("Notes:", ...plan.notes.map((n) => `  - ${n}`));
  if (plan.problems.length > 0) {
    lines.push(`Problems (${plan.problems.length}):`);
    for (const p of plan.problems) lines.push(`  - ${p.detail}`, `    Hint: ${p.hint}`, `    Docs: ${p.docs}`);
  }
  lines.push("", plan.agent_message, plan.summary);
  return lines.join("\n");
}
