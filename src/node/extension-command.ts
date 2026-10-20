/**
 * `datanotes extension`: install, update, roll back, remove, list and check Datanotes extensions.
 *
 *   datanotes extension install <source> [connection] [--catalog <c>] [--schema <s>] [--map <list>]
 *                               [--create <roles>] [--add <list>] [--dry-run] [--yes] [--json]
 *   datanotes extension update <name> [connection] [--to <ref>] [--from <source>] [--map <list>]
 *                              [--create <roles>] [--add <list>] [--dry-run] [--yes] [--json]
 *   datanotes extension rollback | remove <name> [connection] [--yes] [--json]
 *   datanotes extension list [connection] [--json]
 *   datanotes extension check <folder> [--json]
 *   connection: --database <folder> | --vault <folder> | --url <url> --token-file <file>;
 *               with --store <folder>, --settings <file>
 *
 * Every command but `check` works through the running engine, with the owner's token. `install` and
 * `update` fetch the extension (extension-fetch.ts: no script of it ever runs), read the database
 * (list_tables, describe_table, describe_database), compute the plan (extension-plan.ts), show it, ask,
 * then write one batch, the token `ext-<name>`, its file on this machine and the registry's record.
 * The batch is atomic, the token and the record are not: a failure after the batch undoes what this
 * run did, in reverse order, except a token rotation (the engine forgets the old secret: the new one
 * stays in the token file). rollback and remove act only on the token ext-<name>. Exit codes: 0 done,
 * 1 error or refused, 2 the plan has problems, 3 confirmation needed. With --json, stdout holds one
 * JSON object and nothing is asked. A token's secret is never printed.
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { folderArg, readOptions, type Options, type OptionSpec } from "../api/cli-options";
import { DatanotesClient, DatanotesError, type Transport } from "../api/client";
import { OPERATIONS } from "../api/catalog";
import { codeDir, extensionsHome, readTokenFile, removeTokenFile, tokenPath, writeTokenFile } from "../api/extension-files";
import { sourceLabel, validateModule } from "../api/extension-host";
import { EXT_DOCS, ExtensionError, IDENT, MANIFEST_FILE, type ExtensionManifest } from "../api/extension-manifest";
import { chooseTables, planChanges, renderPlan, type DescribedTable, type ExtensionPlan, type InstallChoices, type PlanInput, type TablesListing } from "../api/extension-plan";
import { DATABASE_ID, RECORD_COMMIT, RECORD_NAME, type ExtensionList, type InstalledExtension } from "../api/extension-record";
import { localEngine } from "../api/local";
import { DOCS_TOOL_NAMES } from "../api/mcp";
import { guidanceOf } from "../core/hints";
import { messageOf } from "../core/message";
import { cachedExtension, checkRef, fetchExtension, inspectFolder, newestTag, parseSource, type ExtensionSource, type FetchedExtension } from "./extension-fetch";
import { runGit, type GitRunner } from "./git-sync";

type Sub = "install" | "update" | "rollback" | "remove" | "list" | "check";

const CONNECTION = ["database", "vault", "store", "settings", "url", "token-file"] as const;
const CHOICES = ["map", "create", "add"] as const;

/** The options of each command (tests/helpers/contract.ts lists them in the contract). */
export const EXTENSION_OPTIONS: Readonly<Record<Sub, OptionSpec>> = {
  install: { values: [...CONNECTION, "catalog", "schema", ...CHOICES], flags: ["dry-run", "yes", "json"] },
  update: { values: [...CONNECTION, "to", "from", ...CHOICES], flags: ["dry-run", "yes", "json"] },
  rollback: { values: [...CONNECTION], flags: ["yes", "json"] },
  remove: { values: [...CONNECTION], flags: ["yes", "json"] },
  list: { values: [...CONNECTION], flags: ["json"] },
  check: { flags: ["json"] },
};

export interface ExtensionIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  /** Both the input and the output are a terminal: only then the command asks. */
  isTTY: boolean;
  /** Write the question on stdout and read one line of answer. */
  ask(question: string): Promise<string>;
}

export interface ExtensionDeps {
  io: ExtensionIo;
  env: Record<string, string | undefined>;
  cwd: string;
  git?: GitRunner;
  now?: () => Date;
  transport?: Transport;
}

type Deps = ExtensionDeps & { git: GitRunner; now: () => Date };

/** The streams of the process by default; tests pass PassThrough streams. `ask` uses node:readline/promises on them. */
export function nodeIo(
  p: { stdin: NodeJS.ReadableStream & { isTTY?: boolean }; stdout: NodeJS.WritableStream & { isTTY?: boolean }; stderr: NodeJS.WritableStream } = process,
): ExtensionIo {
  return {
    stdout: p.stdout,
    stderr: p.stderr,
    isTTY: Boolean(p.stdin.isTTY) && Boolean(p.stdout.isTTY),
    async ask(question) {
      const rl = createInterface({ input: p.stdin, output: p.stdout, terminal: false });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

// --- choices ----------------------------------------------------------------------------------------

const items = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");

/** --map, --create, --add, --catalog, --schema. Throws ExtensionError. */
export function parseChoices(o: Options): InstallChoices {
  const choices: InstallChoices = { map: {}, columns: {}, create: [], add: {} };
  for (const item of items(o.get("map"))) {
    const parts = item.split("=");
    const left = parts[0]!.split(".");
    const right = parts.length === 2 ? parts[1]! : "";
    // role=table, or role.column=column (the column a plain name too)
    const ok = parts.length === 2 && left.length <= 2 && left.every((x) => IDENT.test(x)) && (left.length === 1 || IDENT.test(right));
    if (!ok) throw new ExtensionError(`--map: "${item}" is neither role=catalog.schema.table nor role.column=column`, "Write --map project=work.planning.project,project.name=title.", EXT_DOCS.tables);
    if (left.length === 2) (choices.columns[left[0]!] ??= {})[left[1]!] = right;
    else {
      const table = right.split(".");
      if (table.length !== 3 || !table.every((x) => IDENT.test(x))) {
        throw new ExtensionError(`--map: "${right}" is not catalog.schema.table`, "Name the table with its catalog and schema, such as work.planning.project: list_tables lists them.", EXT_DOCS.tables);
      }
      choices.map[left[0]!] = right;
    }
  }
  for (const role of items(o.get("create"))) {
    if (!IDENT.test(role)) throw new ExtensionError(`--create: "${role}" is not a role`, "Write --create person,project with roles of the manifest.", EXT_DOCS.tables);
    choices.create.push(role);
  }
  for (const item of items(o.get("add"))) {
    const parts = item.split(".");
    if (parts.length !== 2 || !parts.every((x) => IDENT.test(x))) throw new ExtensionError(`--add: "${item}" is not role.column`, "Write --add person.email,project.kind.", EXT_DOCS.tables);
    (choices.add[parts[0]!] ??= []).push(parts[1]!);
  }
  const catalog = o.get("catalog");
  if (catalog !== undefined) {
    if (!IDENT.test(catalog)) throw new ExtensionError("--catalog must be lowercase letters, digits and _", "Write --catalog work: a catalog of the database (describe_database lists them).", EXT_DOCS.tables);
    choices.catalog = catalog;
  }
  const schema = o.get("schema");
  if (schema !== undefined) {
    if (!IDENT.test(schema)) throw new ExtensionError("--schema must be lowercase letters, digits and _", "Write --schema reading.", EXT_DOCS.tables);
    choices.schema = schema;
  }
  return choices;
}

// --- output -----------------------------------------------------------------------------------------

const out = (d: Deps, text: string): void => void d.io.stdout.write(`${text}\n`);
const printJson = (d: Deps, x: unknown): void => void d.io.stdout.write(`${JSON.stringify(x, null, 2)}\n`);

/** Print an error (JSON: one object with `extra`; text: on stderr, then `after`) and answer 1. */
function fail(e: unknown, json: boolean, d: Deps, extra: Record<string, unknown> = {}, after = ""): number {
  const g = guidanceOf(e);
  if (json) {
    printJson(d, { error: messageOf(e), ...(g ? { hint: g.hint, docs: g.docs } : {}), ...extra });
    return 1;
  }
  // a DatanotesError's message already ends with its Hint and Docs lines
  const text = e instanceof DatanotesError || !g ? messageOf(e) : `${messageOf(e)}\n${g.hint}\nSee ${g.docs}`;
  d.io.stderr.write(`datanotes extension: ${text}\n${after === "" ? "" : `${after}\n`}`);
  return 1;
}

/** An engine refusal, thrown: its text carries its own Hint and Docs lines. */
async function op<T>(client: DatanotesClient, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await client.call(name, args);
  if (!r.ok) throw new Error(String(r.value));
  return r.value as T;
}

/** Ask before writing: null to go on, else the exit code (1 cancelled, 3 confirmation needed). */
async function confirm(question: string, yes: boolean, json: boolean, d: Deps, payload: Record<string, unknown>): Promise<number | null> {
  if (yes) return null;
  if (!json && d.io.isTTY) {
    const answer = (await d.io.ask(question)).trim().toLowerCase();
    if (answer === "yes" || answer === "y") return null;
    out(d, "Cancelled: nothing was written.");
    return 1;
  }
  d.io.stderr.write("datanotes extension: confirmation needed: run the command again with --yes once the user approved the plan\n");
  if (json) printJson(d, { ...payload, confirmation_needed: true });
  return 3;
}

// --- the engine -------------------------------------------------------------------------------------

interface Session {
  client: DatanotesClient;
  databaseId: string;
  records: InstalledExtension[];
  /** The named tokens (not read by list). */
  tokens: string[];
  home: string;
}

function readToken(file: string, cwd: string): string {
  let token = "";
  try {
    token = fs.readFileSync(path.resolve(cwd, file), "utf8").trim();
  } catch {
    // reported below, as an empty file is
  }
  if (token === "") throw new ExtensionError(`cannot read a token from ${file}`, "Pass a file holding the owner's token: --token-file <file>.", EXT_DOCS.install);
  return token;
}

async function connect(sub: Sub, o: Options, d: Deps): Promise<Session> {
  const env = d.env;
  const folderGiven = o.get("database") !== undefined || o.get("vault") !== undefined;
  const urlGiven = o.get("url") !== undefined || o.get("token-file") !== undefined;
  if (folderGiven && urlGiven) {
    throw new ExtensionError("pass --database (or --vault), or --url with --token-file, not both", "Name the engine one way: the folder it serves, or its address and the owner's token.", EXT_DOCS.install);
  }
  let url: string;
  let token: string;
  if (urlGiven || (!folderGiven && !env.DATANOTES_DATABASE && !env.DATANOTES_VAULT && env.DATANOTES_URL)) {
    const given = o.get("url") ?? env.DATANOTES_URL;
    const file = o.get("token-file") ?? env.DATANOTES_TOKEN_FILE;
    if (!file) throw new ExtensionError("--url needs --token-file", "Pass the owner's token in a file: --token-file <file>.", EXT_DOCS.install);
    if (!given) throw new ExtensionError("--token-file needs --url", "Pass the engine's address: --url http://127.0.0.1:27150.", EXT_DOCS.install);
    token = readToken(file, d.cwd);
    url = given.replace(/\/+$/, "");
  } else {
    const folder = folderArg(o, env, `datanotes extension ${sub}`)!.folder;
    const store = o.get("store");
    const settings = o.get("settings") ?? env.DATANOTES_SETTINGS;
    const found = localEngine(path.resolve(d.cwd, folder), {
      env,
      ...(store ? { store: path.resolve(d.cwd, store) } : {}),
      ...(settings ? { settingsFile: path.resolve(d.cwd, settings) } : {}),
    });
    if (found === null) {
      throw new ExtensionError(`no engine runs on ${folder}`, "Start it first (datanotes serve --database <folder>, or --vault); datanotes status shows whether one runs.", EXT_DOCS.install);
    }
    url = found.url;
    token = found.token;
  }
  const client = new DatanotesClient({ url, token, actor: { harness: "datanotes extension" }, ...(d.transport ? { transport: d.transport } : {}) });

  let list: ExtensionList;
  try {
    list = await client.post<ExtensionList>("/extensions/", {});
  } catch (e) {
    if (e instanceof DatanotesError && e.status === 404) {
      throw new ExtensionError(`the engine at ${url} keeps no extension registry`, "Update the engine to Datanotes 3.3.0 or later and start it again.", EXT_DOCS.install);
    }
    throw e;
  }
  // the id names a folder of the token files: only a real database id counts
  const databaseId = typeof list.database_id === "string" && DATABASE_ID.test(list.database_id) ? list.database_id : null;
  if (databaseId === null) {
    throw new ExtensionError("the engine reports no database id", "Run the headless engine (datanotes serve --database <folder>): extensions need its store.", EXT_DOCS.where);
  }
  const records = Array.isArray(list.extensions) ? list.extensions : [];

  let tokens: string[] = [];
  if (sub !== "list") {
    try {
      tokens = (await client.post<{ tokens: { name: string }[] }>("/tokens/", {})).tokens.map((t) => t.name);
    } catch (e) {
      if (e instanceof DatanotesError && e.status === 403) {
        throw new ExtensionError(
          "datanotes extension needs the owner's token: the engine refused /tokens/ to this one",
          "Run the command with --database on the engine's machine (it reads the owner's token from the store), or pass the owner's token with --token-file.",
          EXT_DOCS.install,
        );
      }
      throw e;
    }
  }
  return { client, databaseId, records, tokens, home: extensionsHome(env) };
}

interface State {
  engineVersion: string;
  listing: TablesListing;
  bases: { name: string; columns: string[] }[];
}

async function readState(s: Session): Promise<State> {
  const root = await s.client.request("GET", "/");
  const version = (root.json as { version?: unknown } | undefined)?.version;
  const db = await op<{ config: { default_catalog: string }; bases: { name: string; columns: string[] }[] }>(s.client, "describe_database", {});
  const lt = await op<{ tables: TablesListing["tables"]; views: TablesListing["views"] }>(s.client, "list_tables", {});
  return {
    engineVersion: typeof version === "string" ? version : "",
    listing: { default_catalog: db.config.default_catalog, tables: lt.tables, views: lt.views },
    bases: db.bases.map((b) => ({ name: b.name, columns: b.columns })),
  };
}

async function planFor(s: Session, fetched: FetchedExtension, choices: InstallChoices, installed: InstalledExtension | null, oldManifest: ExtensionManifest | null, d: Deps): Promise<ExtensionPlan> {
  const { engineVersion, listing, bases } = await readState(s);
  const { chosen, problems } = chooseTables(fetched.manifest, listing, choices, installed);
  const described: Record<string, DescribedTable> = {};
  for (const c of chosen) {
    if ((c.decision === "adopt" || c.decision === "match") && c.table !== null) described[c.table] = await op<DescribedTable>(s.client, "describe_table", { table: c.table });
  }
  const input: PlanInput = {
    manifest: fetched.manifest,
    source: { label: fetched.label, record: fetched.source, commit: fetched.commit, manifest_sha256: fetched.manifestSha256, entry_sha256: fetched.entrySha256 },
    engineVersion,
    listing,
    chosen,
    choiceProblems: problems,
    described,
    bases,
    choices,
    tokens: s.tokens,
    installed,
    oldManifest,
    others: s.records.filter((r) => r.name !== fetched.manifest.name),
    reservedTools: [...OPERATIONS.map((o) => o.name), ...DOCS_TOOL_NAMES],
    localTokenPresent: readTokenFile(tokenPath(s.home, s.databaseId, fetched.manifest.name)) !== null,
    now: d.now().toISOString(),
  };
  return planChanges(input);
}

// --- install, update --------------------------------------------------------------------------------

const RESTART = "Restart your MCP server (or your MCP client) to load its tools.";

/** Show the plan, ask, write it (steps 7.3 to 7.7 of install, shared with update). */
async function present(s: Session, plan: ExtensionPlan, o: Options, d: Deps, json: boolean): Promise<number> {
  const { name, version, from_version: from } = plan.extension;
  if (!json) out(d, renderPlan(plan));
  if (!plan.ready) {
    if (json) printJson(d, plan);
    return 2;
  }
  if (o.has("dry-run")) {
    if (json) printJson(d, plan);
    return 0;
  }
  if (plan.action === "repair" && plan.operations.length === 0 && plan.token.action === "keep") {
    if (json) printJson(d, { ...plan, nothing_to_do: true });
    else out(d, `Nothing to repair: ${name} ${version} is installed as planned.`);
    return 0;
  }
  const question = {
    install: `Install ${name} ${version} with this plan? Type yes to go on: `,
    repair: `Repair ${name} ${version} with this plan? Type yes to go on: `,
    update: `Update ${name} from ${from} to ${version} with this plan? Type yes to go on: `,
  }[plan.action];
  const stop = await confirm(question, o.has("yes"), json, d, plan as unknown as Record<string, unknown>);
  if (stop !== null) return stop;
  return applyPlan(s, plan, d, json);
}

/** The batch, the token, its file, the record; a failure after the batch undoes what this run did. */
async function applyPlan(s: Session, plan: ExtensionPlan, d: Deps, json: boolean): Promise<number> {
  const { name, version } = plan.extension;
  const t = plan.token;
  let migrationId: string | null = null;
  if (plan.operations.length > 0) {
    // atomic: a refusal wrote nothing
    const done = await op<{ migration_id: string }>(s.client, "batch", { operations: plan.operations, summary: `${plan.action} extension ${name} ${version}` });
    migrationId = done.migration_id;
  }
  const file = tokenPath(s.home, s.databaseId, name);
  const did = { file: false, created: false, patterns: false };
  // what a rotation leaves: it cannot be undone, the engine forgot the old secret (R4-Q3)
  let rotation: string | null = null;
  try {
    let secret: string | null = null;
    if (t.action === "create") {
      secret = (await s.client.post<{ token: string }>("/tokens/create/", { name: t.name, description: `Extension ${name} ${version}: the engine calls of its tools`, write: t.write })).token;
      did.created = true;
    } else if (t.action === "rotate" || t.action === "update") {
      if (t.action === "rotate") {
        const fresh = (await s.client.post<{ token: string }>("/tokens/rotate/", { name: t.name })).token;
        // written now and kept whatever fails next: this file is all that holds the token's secret
        rotation = `the token ${t.name} with a new secret this machine could not save`;
        writeTokenFile(file, fresh);
        rotation = `the token ${t.name} with a new secret, kept in ${file}`;
      }
      did.patterns = true;
      await s.client.post("/tokens/update/", { name: t.name, write: t.write });
    }
    if (secret !== null) {
      did.file = true;
      writeTokenFile(file, secret);
    }
    await s.client.post("/extensions/record/", { ...plan.record, migration_id: migrationId });
  } catch (e) {
    // undo in reverse order, every step tried whatever the one before did
    const left: string[] = [];
    if (did.file) {
      try {
        removeTokenFile(file);
      } catch {
        left.push(`the token file ${file}`);
      }
    }
    if (did.created) {
      try {
        await s.client.post("/tokens/delete/", { name: t.name });
      } catch {
        left.push(`the token ${t.name}`);
      }
    }
    // a rotation is never undone: it is named in what is left
    if (rotation !== null) left.push(rotation);
    if (did.patterns && t.previous_write !== null) {
      try {
        await s.client.post("/tokens/update/", { name: t.name, write: t.previous_write });
      } catch {
        left.push("the token's write patterns");
      }
    }
    let batchLeft = false;
    if (migrationId !== null) {
      try {
        await op(s.client, "undo_migration", { migration_id: migrationId });
      } catch {
        left.push(`the batch ${migrationId}`);
        batchLeft = true;
      }
    }
    if (left.length === 0) return fail(e, json, d, { rolled_back: true }, `Rolled back: nothing of this ${plan.action} is left.`);
    return fail(e, json, d, { rolled_back: false, left }, `Could not roll back: left ${left.join(", ")}${batchLeft ? `; undo the batch with undo_migration ${migrationId}` : ""}.`);
  }
  if (json) printJson(d, { plan, applied: { migration_id: migrationId, token: t.action, record: true } });
  else {
    const done = { install: `Installed ${name} ${version}.`, repair: `Repaired ${name} ${version}.`, update: `Updated ${name} to ${version}.` }[plan.action];
    out(d, `${done} ${RESTART} Undo: datanotes extension rollback ${name}.`);
  }
  return 0;
}

async function install(source: string, o: Options, d: Deps, json: boolean): Promise<number> {
  const src = parseSource(source, d.cwd);
  const choices = parseChoices(o);
  const s = await connect("install", o, d);
  const fetched = await fetchExtension(src, { home: s.home, git: d.git });
  const installed = s.records.find((r) => r.name === fetched.manifest.name) ?? null;
  // the same version and commit: a repair; another version installed: the planner's already_installed
  const repair = installed !== null && installed.version === fetched.manifest.version && installed.commit === fetched.commit;
  const plan = await planFor(s, fetched, choices, installed, repair ? fetched.manifest : null, d);
  return present(s, plan, o, d, json);
}

function notInstalled(name: string, hint: string, docs: string): ExtensionError {
  return new ExtensionError(`${name} is not installed`, hint, docs);
}

/** The git source of a record: its URL comes from the engine, so it goes through parseSource before git sees it. */
function gitBase(installed: InstalledExtension, cwd: string): ExtensionSource & { kind: "git" } {
  let base: ExtensionSource | null = null;
  try {
    base = parseSource(installed.source.url ?? "", cwd);
  } catch {
    base = null;
  }
  if (base === null || base.kind !== "git") {
    throw new ExtensionError(`the record of ${installed.name} names no git source`, "Update it from a source you give: --from <source>.", EXT_DOCS.update);
  }
  return base;
}

async function update(name: string, o: Options, d: Deps, json: boolean): Promise<number> {
  checkName(name, EXT_DOCS.update);
  const choices = parseChoices(o);
  const s = await connect("update", o, d);
  const installed = s.records.find((r) => r.name === name);
  if (installed === undefined) throw notInstalled(name, "datanotes extension list shows what is installed; install it first.", EXT_DOCS.update);
  const to = o.get("to");
  const from = o.get("from");
  if (to !== undefined && from !== undefined) {
    throw new ExtensionError("pass --to or --from, not both", "--to moves along the installed source; --from names another source with its own ref (owner/repo@v1.2.0).", EXT_DOCS.update);
  }
  let src: ExtensionSource;
  if (from !== undefined) src = parseSource(from, d.cwd);
  else if (installed.source.kind === "git") {
    const base = gitBase(installed, d.cwd);
    const ref = to ?? (await newestTag(base.cloneUrl ?? base.url, d.git));
    checkRef(ref);
    src = { ...base, ref, label: `${base.label}#${ref}` };
  } else {
    if (to !== undefined) throw new ExtensionError("--to needs a git source", "Pass --from <folder> to update from a folder.", EXT_DOCS.update);
    src = parseSource(installed.source.path ?? "", d.cwd);
  }
  const fetched = await fetchExtension(src, { home: s.home, git: d.git });
  if (fetched.manifest.name !== name) {
    throw new ExtensionError(
      `${fetched.label} holds the extension ${fetched.manifest.name}, not ${name}`,
      "Pass the source of the installed extension, or install the other one: datanotes extension install <source>.",
      EXT_DOCS.update,
    );
  }
  if (fetched.manifest.version === installed.version && fetched.commit === installed.commit) {
    if (json) printJson(d, { up_to_date: true, name, version: installed.version });
    else out(d, `${name} ${installed.version} is up to date.`);
    return 0;
  }
  // the installed version's manifest: from the cache, else fetched again at its commit (a git record)
  let oldManifest: ExtensionManifest | null = null;
  if (typeof installed.commit === "string" && RECORD_COMMIT.test(installed.commit)) {
    oldManifest = cachedExtension(s.home, name, installed.commit)?.manifest ?? null;
    if (oldManifest === null && installed.source.kind === "git" && /^[0-9a-f]{40}$/.test(installed.commit)) {
      const base = gitBase(installed, d.cwd);
      oldManifest = (await fetchExtension({ ...base, ref: installed.commit, label: `${base.label}#${installed.commit}` }, { home: s.home, git: d.git })).manifest;
    }
  }
  if (oldManifest === null) {
    throw new ExtensionError("the installed version's code is not in the cache", "Install it again from the same folder state, or update from a git source.", EXT_DOCS.update);
  }
  const plan = await planFor(s, fetched, choices, installed, oldManifest, d);
  return present(s, plan, o, d, json);
}

// --- rollback, remove -------------------------------------------------------------------------------

function checkName(name: string, docs: string): void {
  if (!RECORD_NAME.test(name)) {
    throw new ExtensionError(`"${name}" is not an extension name`, "Extension names are 2 to 40 lowercase letters, digits or -, starting with a letter: datanotes extension list shows the installed ones.", docs);
  }
}

/** A record names its own token, ext-<name>: rollback and remove change or delete only that one (R4-Q4). */
function checkRecordToken(installed: InstalledExtension): void {
  const own = `ext-${installed.name}`;
  if (installed.token !== own) {
    throw new ExtensionError(
      `the record of ${installed.name} names the token ${String(installed.token)}, not ${own}`,
      `datanotes extension install writes only records whose token is ${own}. Delete this one (POST /datanotes/extensions/delete/ with {"name": "${installed.name}"}, owner only), then run datanotes extension remove ${installed.name}.`,
      EXT_DOCS.remove,
    );
  }
}

async function rollback(name: string, o: Options, d: Deps, json: boolean): Promise<number> {
  checkName(name, EXT_DOCS.rollback);
  const s = await connect("rollback", o, d);
  const installed = s.records.find((r) => r.name === name);
  if (installed === undefined) throw notInstalled(name, "datanotes extension list shows what is installed; install it first.", EXT_DOCS.rollback);
  checkRecordToken(installed);
  const { version, previous, migration_id: batch } = installed;
  if (!json) {
    out(d, `Roll back ${name} ${version}: undo batch ${batch ?? "none"}; then ${previous !== null ? `go back to ${previous.version}` : "remove its token, its token file and its record"}.`);
  }
  const toVersion = previous !== null ? previous.version : null;
  const stop = await confirm(`Roll back ${name} ${version}? Type yes to go on: `, o.has("yes"), json, d, { rollback: { name, version, migration_id: batch, to_version: toVersion } });
  if (stop !== null) return stop;

  if (batch !== null) {
    const undoneAlready = (): void => {
      if (!json) out(d, `The batch ${batch} was undone already.`);
    };
    const listed = await op<{ migrations: { migration_id: string; undone?: boolean }[] }>(s.client, "list_migrations", { op: "batch", limit: 1000 });
    if (listed.migrations.some((m) => m.migration_id === batch && m.undone === true)) undoneAlready();
    else {
      const r = await s.client.call("undo_migration", { migration_id: batch });
      if (r.ok) {
        // undone
      } else if (String(r.value).includes("migration already undone")) undoneAlready();
      else throw new Error(String(r.value));
    }
  }
  try {
    if (previous !== null) {
      await s.client.post("/tokens/update/", { name: installed.token, write: previous.write });
      await s.client.post("/extensions/record/", previous);
      if (!json) out(d, `Rolled back ${name} to ${previous.version}.`);
    } else {
      await s.client.post("/tokens/delete/", { name: installed.token });
      removeTokenFile(tokenPath(s.home, s.databaseId, name));
      await s.client.post("/extensions/delete/", { name });
      if (!json) out(d, `Rolled back the install of ${name}: its token and record are gone.`);
    }
  } catch (e) {
    if (batch === null) throw e;
    return fail(e, json, d, { undone: batch }, `The batch ${batch} is undone; run datanotes extension rollback ${name} again to finish.`);
  }
  if (json) printJson(d, { rolled_back: { name, from_version: version, to_version: toVersion, undone: batch, removed: previous === null } });
  return 0;
}

async function remove(name: string, o: Options, d: Deps, json: boolean): Promise<number> {
  checkName(name, EXT_DOCS.remove);
  const s = await connect("remove", o, d);
  const installed = s.records.find((r) => r.name === name);
  const file = tokenPath(s.home, s.databaseId, name);
  if (installed === undefined) {
    const tokenName = `ext-${name}`;
    const tokenKnown = s.tokens.includes(tokenName);
    if (!tokenKnown && readTokenFile(file) === null) throw notInstalled(name, "datanotes extension list shows what is installed.", EXT_DOCS.remove);
    const stop = await confirm(`Remove what an earlier install of ${name} left (token, token file)? Type yes to go on: `, o.has("yes"), json, d, { remove: { name, leftovers: true } });
    if (stop !== null) return stop;
    if (tokenKnown) await s.client.post("/tokens/delete/", { name: tokenName });
    removeTokenFile(file);
    if (json) printJson(d, { removed: { name, tables: [], migration_id: null, leftovers: true } });
    else out(d, `Removed what an earlier install of ${name} left.`);
    return 0;
  }
  checkRecordToken(installed);
  const owned = Object.values(installed.tables)
    .filter((t) => t.owned)
    .map((t) => t.table);
  if (!json) out(d, `Remove ${name} ${installed.version}: keep its tables (${owned.join(", ")}); remove their extension tags, the token ${installed.token}, its file on this machine and the record.`);
  const stop = await confirm(`Remove ${name}? Type yes to go on: `, o.has("yes"), json, d, { remove: { name, version: installed.version, tables: owned } });
  if (stop !== null) return stop;

  const listed = await op<{ tables: { qualified: string }[] }>(s.client, "list_tables", {});
  const present = new Set(listed.tables.map((t) => t.qualified));
  const operations = owned.filter((t) => present.has(t)).map((table) => ({ op: "alter_table", table, tags: { extension: null, extension_role: null } }));
  let migrationId: string | null = null;
  if (operations.length > 0) {
    const done = await op<{ migration_id: string }>(s.client, "batch", { operations, summary: `remove extension ${name}` });
    migrationId = done.migration_id;
  }
  await s.client.post("/extensions/delete/", { name });
  // deleted: false (gone already) is fine
  await s.client.post("/tokens/delete/", { name: installed.token });
  removeTokenFile(file);
  if (json) printJson(d, { removed: { name, tables: owned, migration_id: migrationId } });
  else out(d, `Removed ${name}. Its tables stay: ${owned.join(", ")}.${migrationId !== null ? ` Undo the tag change with undo_migration ${migrationId}.` : ""}`);
  return 0;
}

// --- list, check ------------------------------------------------------------------------------------

async function list(o: Options, d: Deps, json: boolean): Promise<number> {
  const s = await connect("list", o, d);
  const batches = await op<{ migrations: { migration_id: string; undone?: boolean }[] }>(s.client, "list_migrations", { op: "batch", limit: 1000 });
  const undoneIds = new Set(batches.migrations.filter((m) => m.undone === true).map((m) => m.migration_id));
  const rows = s.records.map((r) => {
    // a record comes from the engine: a path is built only from a name and a commit that pass their rules
    const valid = typeof r.name === "string" && RECORD_NAME.test(r.name) && typeof r.commit === "string" && RECORD_COMMIT.test(r.commit);
    const code = valid && fs.existsSync(path.join(codeDir(s.home, r.name, r.commit), MANIFEST_FILE));
    const token = valid && readTokenFile(tokenPath(s.home, s.databaseId, r.name)) !== null;
    const undone = r.migration_id !== null && undoneIds.has(r.migration_id);
    return { ...r, local: { code, token }, undone };
  });
  if (json) {
    printJson(d, { database_id: s.databaseId, extensions: rows });
    return 0;
  }
  if (rows.length === 0) {
    out(d, "No extension is installed.");
    return 0;
  }
  const yes = (b: boolean): string => (b ? "yes" : "no");
  const blocks = rows.map((r) => {
    const commit = String(r.commit);
    const label = sourceLabel(r);
    const lines = [
      `${r.name} ${r.version}  ${r.source.kind} ${label} (${commit.startsWith("local-") ? commit : commit.slice(0, 12)})`,
      `  tables: ${Object.entries(r.tables)
        .map(([role, t]) => `${role} ${t.table}${t.owned ? " (own)" : ""}`)
        .join(", ")}`,
      `  tools: ${r.tools.join(", ")}`,
      `  token: ${r.token}, ${r.write.length > 0 ? `writes ${r.write.join(", ")}` : "writes nothing"}`,
      `  this machine: code ${yes(r.local.code)}, token ${yes(r.local.token)}`,
    ];
    if (!r.local.code || !r.local.token) lines.push(`  repair: datanotes extension install ${label}`);
    if (r.undone) lines.push(`  the batch ${r.migration_id} was undone by hand: run datanotes extension rollback ${r.name} to bring the record in step`);
    return lines.join("\n");
  });
  out(d, blocks.join("\n\n"));
  return 0;
}

async function check(folder: string, d: Deps, json: boolean): Promise<number> {
  const dir = path.resolve(d.cwd, folder);
  const c = inspectFolder(dir, folder);
  const m = c.manifest;
  let mod: unknown;
  try {
    mod = ((await import(/* @vite-ignore */ pathToFileURL(path.join(dir, ...m.entry.split("/"))).href)) as { default?: unknown }).default;
  } catch (e) {
    throw new ExtensionError(`the entry did not load: ${messageOf(e)}`, "Run the entry with node to see the error, then build it again.", EXT_DOCS.layout);
  }
  const problems = validateModule(mod, m);
  const toolsDoc = path.join(dir, "docs", "tools.md");
  if (fs.existsSync(toolsDoc)) {
    const headings = new Set(fs.readFileSync(toolsDoc, "utf8").split(/\r?\n/).map((l) => l.trimEnd()));
    for (const t of m.tools) if (!headings.has(`## ${t.name}`)) problems.push(`docs/tools.md has no "## ${t.name}" heading`);
  }
  if (problems.length > 0) {
    if (json) printJson(d, { ok: false, problems });
    else out(d, problems.map((p) => `- ${p}`).join("\n"));
    return 2;
  }
  const counts = {
    tools: m.tools.length,
    tables: m.roles.length,
    owned: m.roles.filter((r) => m.tables[r]!.owned).length,
    views: Object.keys(m.views).length,
    bases: Object.keys(m.bases).length,
  };
  if (json) printJson(d, { ok: true, name: m.name, version: m.version, ...counts });
  else out(d, `ok: ${m.name} ${m.version}: ${counts.tools} tools, ${counts.tables} tables (${counts.owned} own), ${counts.views} views, ${counts.bases} bases`);
  return 0;
}

// --- the command ------------------------------------------------------------------------------------

const SUBS: readonly Sub[] = ["install", "update", "rollback", "remove", "list", "check"];
const POSITIONAL: Readonly<Record<Exclude<Sub, "list">, string>> = { install: "source", update: "name", rollback: "name", remove: "name", check: "folder" };

async function run(argv: string[], d: Deps, json: boolean): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || !(SUBS as readonly string[]).includes(sub)) {
    throw new ExtensionError(`unknown command "extension ${sub ?? ""}"`, "The commands are install, update, rollback, remove, list and check (datanotes --help).", EXT_DOCS.install);
  }
  const command = sub as Sub;
  // list takes no positional argument: readOptions refuses one
  const positional = command !== "list" && rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : undefined;
  const o = readOptions(positional !== undefined ? rest.slice(1) : rest, EXTENSION_OPTIONS[command], `datanotes extension ${command}`);
  if (command === "list") return list(o, d, json);
  const what = POSITIONAL[command];
  if (positional === undefined) {
    throw new ExtensionError(`datanotes extension ${command} needs its <${what}>`, `Write: datanotes extension ${command} <${what}> [options] (datanotes --help lists them).`, EXT_DOCS.install);
  }
  if (command === "install") return install(positional, o, d, json);
  if (command === "update") return update(positional, o, d, json);
  if (command === "rollback") return rollback(positional, o, d, json);
  if (command === "remove") return remove(positional, o, d, json);
  return check(positional, d, json);
}

/** `datanotes extension <argv>`: the exit code (0 done, 1 error, 2 plan problems, 3 confirmation needed). Never throws. */
export async function extensionMain(argv: string[], deps: Partial<ExtensionDeps> = {}): Promise<number> {
  const d: Deps = {
    io: deps.io ?? nodeIo(),
    env: deps.env ?? process.env,
    cwd: deps.cwd ?? process.cwd(),
    git: deps.git ?? runGit,
    now: deps.now ?? (() => new Date()),
    ...(deps.transport ? { transport: deps.transport } : {}),
  };
  // read first: even an option error is one JSON object
  const json = argv.includes("--json");
  try {
    return await run(argv, d, json);
  } catch (e) {
    return fail(e, json, d);
  }
}
