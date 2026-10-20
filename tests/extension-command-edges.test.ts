/**
 * `datanotes extension` (src/node/extension-command.ts): its refusals, its connection rules, and what
 * it does when a step fails halfway (the batch undone, the token and its file taken back), on a real
 * engine with some answers intercepted. Each test that installs gets its own catalog (e<n>); an
 * afterEach removes the record, the token and the token file, so each test starts without them.
 * The tests use their own data home: code and token files of other test files are never touched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readOptions } from "../src/api/cli-options";
import { DatanotesClient, fetchTransport, type HttpRequest, type HttpResponse, type Transport } from "../src/api/client";
import { codeDir, removeTokenFile, tokenPath, writeTokenFile } from "../src/api/extension-files";
import { EXT_DOCS } from "../src/api/extension-manifest";
import type { InstalledExtension } from "../src/api/extension-record";
import { storeLocation } from "../src/api/local";
import { EXTENSION_OPTIONS, extensionMain, nodeIo, parseChoices, type ExtensionIo } from "../src/node/extension-command";
import type { GitRunner } from "../src/node/git-sync";
import { BOOKS_V1, BOOKS_V2 } from "./helpers/extensions";
import { openTestVault, type TestVault } from "./helpers/test-vault";

const OWNER = "test-vault-token";

interface FakeIo extends ExtensionIo {
  out: string;
  err: string;
  questions: string[];
}

function fakeIo(o: { tty?: boolean; answers?: string[] } = {}): FakeIo {
  const answers = [...(o.answers ?? [])];
  const io: FakeIo = {
    out: "",
    err: "",
    questions: [],
    isTTY: o.tty ?? false,
    stdout: { write: (s: string) => void (io.out += s) },
    stderr: { write: (s: string) => void (io.err += s) },
    ask: async (q: string) => {
      io.questions.push(q);
      return answers.shift() ?? "";
    },
  };
  return io;
}

/** A transport that answers some requests itself and sends the rest to the engine. */
function intercept(answer: (req: HttpRequest) => HttpResponse | undefined | Promise<HttpResponse | undefined>): Transport {
  return async (req) => (await answer(req)) ?? fetchTransport(req);
}
const json = (status: number, body: unknown): HttpResponse => ({ status, text: JSON.stringify(body) });

let vault: TestVault;
let owner: DatanotesClient;
let tmp: string;
let home: string;
let env: Record<string, string | undefined>;
let store: string;
let databaseId: string;
let ownerFile: string;

beforeAll(async () => {
  vault = await openTestVault("service");
  owner = vault.client;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-ext-cmd-edges-"));
  // a data home of these tests' own: the engine is reached through --store
  env = { ...process.env, DATANOTES_DATA_HOME: path.join(tmp, "home") };
  home = path.join(tmp, "home", "extensions");
  store = storeLocation(vault.root)!.store;
  databaseId = (await owner.post<{ database_id: string }>("/extensions/", {})).database_id;
  ownerFile = path.join(tmp, "owner.token");
  fs.writeFileSync(ownerFile, `${OWNER}\n`);
}, 60_000);

afterAll(async () => {
  await vault?.stop();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterEach(async () => {
  await owner.post("/extensions/delete/", { name: "books" });
  await owner.post("/tokens/delete/", { name: "ext-books" });
  removeTokenFile(file());
}, 30_000);

const url = () => owner.url;
const file = () => tokenPath(home, databaseId, "books");
const conn = (): string[] => ["--vault", vault.root, "--store", store];
const route = (r: string) => `${url()}/datanotes${r}`;
const operation = (name: string) => `${url()}/datanotes/operations/${name}/`;

interface Run {
  code: number;
  io: FakeIo;
}
async function cli(argv: string[], o: { tty?: boolean; answers?: string[]; transport?: Transport; env?: Record<string, string | undefined>; git?: GitRunner } = {}): Promise<Run> {
  const io = fakeIo(o);
  const code = await extensionMain(argv, { io, env: o.env ?? env, cwd: tmp, ...(o.transport ? { transport: o.transport } : {}), ...(o.git ? { git: o.git } : {}) });
  return { code, io };
}
/** Install a books folder into its own catalog e<n>, person bound to work.planning.person. */
const install = (n: string, o: { folder?: string; extra?: string[]; transport?: Transport; yes?: boolean } = {}): Promise<Run> =>
  cli(["install", o.folder ?? BOOKS_V1, ...conn(), "--catalog", `e${n}`, "--map", "person=work.planning.person", ...(o.yes === false ? [] : ["--yes"]), ...(o.extra ?? [])], o.transport ? { transport: o.transport } : {});

async function record(): Promise<InstalledExtension | undefined> {
  return (await owner.post<{ extensions: InstalledExtension[] }>("/extensions/", {})).extensions.find((r) => r.name === "books");
}
async function token(): Promise<{ name: string; write?: string[] } | undefined> {
  return (await owner.post<{ tokens: { name: string; write?: string[] }[] }>("/tokens/", {})).tokens.find((t) => t.name === "ext-books");
}
async function tableGone(table: string): Promise<boolean> {
  return !(await owner.call("describe_table", { table })).ok;
}

/** A copy of the books fixture, its manifest changed. */
function copyOf(from: string, name: string, edit: (m: any) => void): string {
  const dir = path.join(tmp, name);
  fs.cpSync(from, dir, { recursive: true });
  const f = path.join(dir, "datanotes-extension.json");
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  edit(m);
  fs.writeFileSync(f, JSON.stringify(m, null, 2));
  return dir;
}

/** A record of books as the registry could answer it, with some fields changed. */
function fakeRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "books",
    version: "0.1.0",
    description: "A reading list",
    api: 1,
    source: { kind: "git", url: "https://example.com/team/books.git", ref: "v0.1.0" },
    commit: "a".repeat(40),
    manifest_sha256: "m",
    entry_sha256: "e",
    token: "ext-books",
    tables: { person: { table: "work.planning.person", owned: false }, book: { table: "work.books.book", owned: true } },
    tools: ["list_reading", "finish_book"],
    write: ["work.books.book"],
    migration_id: null,
    installed_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    previous: null,
    ...over,
  };
}
/** The registry answering these records, the rest from the engine. */
const withRecords = (records: unknown[], more: (req: HttpRequest) => HttpResponse | undefined = () => undefined): Transport =>
  intercept((req) => (req.url === route("/extensions/") ? json(200, { database_id: databaseId, extensions: records }) : more(req)));

describe("datanotes extension: refusals, connections and failures", { timeout: 60_000 }, () => {
  it("refuses an unknown or a missing subcommand", async () => {
    const hint = "The commands are install, update, rollback, remove, list and check (datanotes --help).";
    const frob = await cli(["frob"]);
    expect(frob.code).toBe(1);
    expect(frob.io.err).toBe(`datanotes extension: unknown command "extension frob"\n${hint}\nSee ${EXT_DOCS.install}\n`);
    const none = await cli([]);
    expect(none.code).toBe(1);
    expect(none.io.err).toBe(`datanotes extension: unknown command "extension "\n${hint}\nSee ${EXT_DOCS.install}\n`);
    const helpAsked = await cli(["--help"]);
    expect(helpAsked.io.err).toContain('unknown command "extension --help"');
  });

  it("refuses a missing positional argument", async () => {
    const r = await cli(["install", "--vault", "x"]);
    expect(r.code).toBe(1);
    expect(r.io.err).toBe(
      `datanotes extension: datanotes extension install needs its <source>\nWrite: datanotes extension install <source> [options] (datanotes --help lists them).\nSee ${EXT_DOCS.install}\n`,
    );
    const check = await cli(["check"]);
    expect(check.io.err).toContain("datanotes extension check needs its <folder>");
    const list = await cli(["list", "x"]);
    expect(list.code).toBe(1);
    expect(list.io.err).toContain('unexpected argument "x"');
  });

  it("parseChoices reads every option", () => {
    const o = readOptions(
      ["--map", "person=work.planning.person, person.name=email,,", "--create", "project", "--add", "person.email", "--catalog", "work", "--schema", "reading"],
      EXTENSION_OPTIONS.install,
      "datanotes extension install",
    );
    expect(parseChoices(o)).toEqual({
      map: { person: "work.planning.person" },
      columns: { person: { name: "email" } },
      create: ["project"],
      add: { person: ["email"] },
      catalog: "work",
      schema: "reading",
    });
    expect(parseChoices(readOptions([], EXTENSION_OPTIONS.install, "x"))).toEqual({ map: {}, columns: {}, create: [], add: {} });
    // the last item of a key wins
    expect(parseChoices(readOptions(["--map", "person=a.b.c,person=d.e.f,person.name=x,person.name=y"], EXTENSION_OPTIONS.install, "x"))).toMatchObject({
      map: { person: "d.e.f" },
      columns: { person: { name: "y" } },
    });
  });

  it("parseChoices refuses bad items, each with its message and hint", () => {
    const refusal = (...argv: string[]) => {
      try {
        parseChoices(readOptions(argv, EXTENSION_OPTIONS.install, "x"));
      } catch (e) {
        const { message, hint, docs } = e as { message: string; hint: string; docs: string };
        return { message, hint, docs };
      }
      throw new Error("not refused");
    };
    const neither = (item: string) => ({ message: `--map: "${item}" is neither role=catalog.schema.table nor role.column=column`, hint: "Write --map project=work.planning.project,project.name=title.", docs: EXT_DOCS.tables });
    expect(refusal("--map", "a")).toEqual(neither("a"));
    expect(refusal("--map", "a.b.c=d")).toEqual(neither("a.b.c=d"));
    expect(refusal("--map", "a=b=c")).toEqual(neither("a=b=c"));
    expect(refusal("--map", "a.b=C")).toEqual(neither("a.b=C"));
    expect(refusal("--map", "a=b.c")).toEqual({
      message: '--map: "b.c" is not catalog.schema.table',
      hint: "Name the table with its catalog and schema, such as work.planning.project: list_tables lists them.",
      docs: EXT_DOCS.tables,
    });
    expect(refusal("--create", "Bad")).toEqual({ message: '--create: "Bad" is not a role', hint: "Write --create person,project with roles of the manifest.", docs: EXT_DOCS.tables });
    expect(refusal("--add", "a")).toEqual({ message: '--add: "a" is not role.column', hint: "Write --add person.email,project.kind.", docs: EXT_DOCS.tables });
    expect(refusal("--catalog", "Bad")).toEqual({
      message: "--catalog must be lowercase letters, digits and _",
      hint: "Write --catalog work: a catalog of the database (describe_database lists them).",
      docs: EXT_DOCS.tables,
    });
    expect(refusal("--schema", "Bad")).toEqual({ message: "--schema must be lowercase letters, digits and _", hint: "Write --schema reading.", docs: EXT_DOCS.tables });
  });

  it("a name that is not an extension name is refused before any engine call", async () => {
    const seen: string[] = [];
    const transport: Transport = async (req) => {
      seen.push(req.url);
      return json(500, { error: "unexpected" });
    };
    const hint = "Extension names are 2 to 40 lowercase letters, digits or -, starting with a letter: datanotes extension list shows the installed ones.";
    for (const [sub, docs] of [
      ["rollback", EXT_DOCS.rollback],
      ["update", EXT_DOCS.update],
      ["remove", EXT_DOCS.remove],
    ] as const) {
      const r = await cli([sub, "../x", "--url", "http://127.0.0.1:1", "--token-file", ownerFile], { transport });
      expect(r.code).toBe(1);
      expect(r.io.err).toBe(`datanotes extension: "../x" is not an extension name\n${hint}\nSee ${docs}\n`);
    }
    expect(seen).toEqual([]);
  });

  it("connection errors", async () => {
    const bare = { DATANOTES_DATA_HOME: env.DATANOTES_DATA_HOME };
    const message = async (argv: string[], e: Record<string, string | undefined> = bare) => {
      const r = await cli(argv, { env: e });
      expect(r.code).toBe(1);
      return r.io.err.split("\n")[0];
    };
    expect(await message(["list", "--url", "http://127.0.0.1:1"])).toBe("datanotes extension: --url needs --token-file");
    expect(await message(["list", "--token-file", ownerFile])).toBe("datanotes extension: --token-file needs --url");
    expect(await message(["list", "--url", "http://127.0.0.1:1", "--token-file", path.join(tmp, "nothing.token")])).toBe(`datanotes extension: cannot read a token from ${path.join(tmp, "nothing.token")}`);
    fs.writeFileSync(path.join(tmp, "empty.token"), "\n");
    expect(await message(["list", "--url", "http://127.0.0.1:1", "--token-file", "empty.token"])).toBe("datanotes extension: cannot read a token from empty.token");
    expect(await message(["list", "--vault", vault.root, "--url", "http://127.0.0.1:1"])).toBe("datanotes extension: pass --database (or --vault), or --url with --token-file, not both");
    const empty = path.join(tmp, "no-engine");
    fs.mkdirSync(empty, { recursive: true });
    expect(await message(["list", "--vault", empty])).toBe(`datanotes extension: no engine runs on ${empty}`);
    expect(await message(["list", "--database", "no-engine", "--store", "no-store", "--settings", "no-settings.json"])).toBe("datanotes extension: no engine runs on no-engine");
    expect(await message(["list"])).toContain("pass --database <folder> (or --vault <folder>)");
    // the address and the token file from the environment
    const fromEnv = await cli(["list"], { env: { ...bare, DATANOTES_URL: `${url()}/`, DATANOTES_TOKEN_FILE: ownerFile } });
    expect(fromEnv.code).toBe(0);
    expect(fromEnv.io.out).toBe("No extension is installed.\n");
    // an engine that does not answer: the client's error, its Hint and Docs lines once
    const down: Transport = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const unreachable = await cli(["list", "--url", "http://127.0.0.1:1", "--token-file", ownerFile], { transport: down });
    expect(unreachable.code).toBe(1);
    expect(unreachable.io.err.startsWith("datanotes extension: engine unreachable at http://127.0.0.1:1: connect ECONNREFUSED\nHint: ")).toBe(true);
    expect(unreachable.io.err.match(/Hint: /g)).toHaveLength(1);
    expect(unreachable.io.err).not.toContain("\nSee ");
  });

  it("an engine without the registry, without a database id, or with a token that is not the owner's", async () => {
    const fake = (answers: Record<string, HttpResponse>): Transport => async (req) => answers[new URL(req.url).pathname] ?? json(500, { error: `unexpected ${req.url}` });
    const run = (sub: string, answers: Record<string, HttpResponse>) => cli([sub, ...(sub === "list" ? [] : ["books"]), "--url", "http://engine.test/", "--token-file", ownerFile], { transport: fake(answers) });
    const ok = json(200, { database_id: databaseId, extensions: [] });

    const old = await run("list", { "/datanotes/extensions/": json(404, { error: "no route" }) });
    expect(old.io.err).toBe(`datanotes extension: the engine at http://engine.test keeps no extension registry\nUpdate the engine to Datanotes 3.3.0 or later and start it again.\nSee ${EXT_DOCS.install}\n`);
    const noId = await run("list", { "/datanotes/extensions/": json(200, { database_id: "../x", extensions: [] }) });
    expect(noId.io.err).toBe(`datanotes extension: the engine reports no database id\nRun the headless engine (datanotes serve --database <folder>): extensions need its store.\nSee ${EXT_DOCS.where}\n`);
    const nullId = await run("list", { "/datanotes/extensions/": json(200, { database_id: null, extensions: [] }) });
    expect(nullId.io.err).toContain("the engine reports no database id");
    const named = await run("rollback", { "/datanotes/extensions/": ok, "/datanotes/tokens/": json(403, { error: "token reader may not call /tokens/ (reserved to the owner)" }) });
    expect(named.code).toBe(1);
    expect(named.io.err).toBe(
      `datanotes extension: datanotes extension needs the owner's token: the engine refused /tokens/ to this one\nRun the command with --database on the engine's machine (it reads the owner's token from the store), or pass the owner's token with --token-file.\nSee ${EXT_DOCS.install}\n`,
    );
    // other failures of the two routes come through as they are
    const broken = await run("list", { "/datanotes/extensions/": json(500, { error: "registry broke" }) });
    expect(broken.io.err).toBe("datanotes extension: registry broke\n");
    const tokensBroken = await run("remove", { "/datanotes/extensions/": ok, "/datanotes/tokens/": json(500, { error: "tokens broke" }) });
    expect(tokensBroken.io.err).toBe("datanotes extension: tokens broke\n");
    // a registry answer without a list of records: none
    const odd = await run("list", { "/datanotes/extensions/": json(200, { database_id: databaseId }), "/datanotes/operations/list_migrations/": json(200, { migrations: [] }) });
    expect(odd.code).toBe(0);
    expect(odd.io.out).toBe("No extension is installed.\n");
  });

  it("plan problems answer 2 with the problem lines", async () => {
    await vault.ok("create_table", {
      catalog: "work",
      schema: "other",
      name: "people",
      aliases: ["person"],
      filename: "{name}",
      description: "Other people",
      columns: [{ name: "name", type: "string", description: "The name" }],
    });
    try {
      const r = await cli(["install", BOOKS_V1, ...conn(), "--catalog", "e8", "--dry-run"]);
      expect(r.code).toBe(2);
      expect(r.io.out).toMatch(/\n {2}- person: 2 tables could be it: [^\n]+\n {4}Hint: Ask the user which one, then pass --map person=<table>, or --create person for a new table\./);
      expect(r.io.out).toContain("books 0.1.0: 1 problem: nothing written");
      const j = await cli(["install", BOOKS_V1, ...conn(), "--catalog", "e8", "--json"]);
      expect(j.code).toBe(2);
      const plan = JSON.parse(j.io.out);
      expect(plan.ready).toBe(false);
      expect(plan.problems.map((p: any) => p.code)).toEqual(["ambiguous_dependency"]);
      expect(await record()).toBeUndefined();
      expect(await tableGone("e8.books.book")).toBe(true);
    } finally {
      await vault.ok("drop_table", { table: "work.other.people" });
    }
  });

  it("with --json, an error is one JSON object", async () => {
    const r = await cli(["install", "nope", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.io.out)).toEqual({
      error: '"nope" is not a source',
      hint: "Give a git URL with #<tag> (https://example.com/team/ext.git#v1.0.0), owner/repo@<tag> for GitHub, or a folder (./my-extension).",
      docs: EXT_DOCS.install,
    });
    expect(r.io.err).toBe("");
  });

  it("installing another version while one is installed answers already_installed", async () => {
    expect((await install("10")).code).toBe(0);
    const r = await install("10", { folder: BOOKS_V2, yes: false, extra: ["--dry-run"] });
    expect(r.code).toBe(2);
    expect(r.io.out).toContain("  - books 0.1.0 is installed\n    Hint: Update it instead: datanotes extension update books --to <ref> (or --from <source>).");
  });

  it("update refusals", async () => {
    const first = (r: Run) => r.io.err.split("\n")[0];
    const absent = await cli(["update", "books", ...conn()]);
    expect(absent.io.err).toBe(`datanotes extension: books is not installed\ndatanotes extension list shows what is installed; install it first.\nSee ${EXT_DOCS.update}\n`);
    expect((await install("11")).code).toBe(0);
    expect(first(await cli(["update", "books", ...conn(), "--to", "v1.0.0"]))).toBe("datanotes extension: --to needs a git source");
    expect(first(await cli(["update", "books", ...conn(), "--to", "v1.0.0", "--from", BOOKS_V2]))).toBe("datanotes extension: pass --to or --from, not both");
    const other = copyOf(BOOKS_V1, "other-11", (m) => (m.name = "other"));
    const wrong = await cli(["update", "books", ...conn(), "--from", other]);
    expect(wrong.code).toBe(1);
    expect(first(wrong)).toBe(`datanotes extension: ${other.split("\\").join("/")} holds the extension other, not books`);
    const same = await cli(["update", "books", ...conn(), "--from", BOOKS_V1]);
    expect(same.code).toBe(0);
    expect(same.io.out).toBe("books 0.1.0 is up to date.\n");
    const sameJson = await cli(["update", "books", ...conn(), "--json"]);
    expect(JSON.parse(sameJson.io.out)).toEqual({ up_to_date: true, name: "books", version: "0.1.0" });
  });

  it("a record whose source is not a git URL is refused before git runs", async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return { code: 1, stdout: "", stderr: "offline" };
    };
    const update = (records: unknown[], extra: string[] = []) => cli(["update", "books", ...conn(), ...extra], { transport: withRecords(records), git });
    const noGit = `datanotes extension: the record of books names no git source\nUpdate it from a source you give: --from <source>.\nSee ${EXT_DOCS.update}\n`;
    expect((await update([fakeRecord({ source: { kind: "git", url: "--upload-pack=x" } })])).io.err).toBe(noGit);
    expect((await update([fakeRecord({ source: { kind: "git" } })])).io.err).toBe(noGit);
    expect((await update([fakeRecord({ source: { kind: "git", url: "." } })])).io.err).toBe(noGit);
    expect(calls).toEqual([]);

    // a URL with credentials: git gets them, no message shows them
    const ls: GitRunner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const secret = await cli(["update", "books", ...conn()], { transport: withRecords([fakeRecord({ source: { kind: "git", url: "https://nora:s3cret@example.com/team/books.git" } })]), git: ls });
    expect(secret.io.err.split("\n")[0]).toBe("datanotes extension: no version tag in https://example.com/team/books.git");
    expect(calls[0]).toEqual(["ls-remote", "--tags", "--refs", "https://nora:s3cret@example.com/team/books.git"]);
    // --to on a git record: fetched at that tag
    const to = await update([fakeRecord({})], ["--to", "v9.9.9"]);
    expect(to.io.err.split("\n")[0]).toBe("datanotes extension: git could not fetch https://example.com/team/books.git at v9.9.9: offline");
    const branch = await update([fakeRecord({})], ["--to", "main"]);
    expect(branch.io.err.split("\n")[0]).toBe('datanotes extension: ref "main" is not a version tag or a commit');
    // a local record without its folder
    expect((await update([fakeRecord({ source: { kind: "local" } })])).io.err.split("\n")[0]).toBe("datanotes extension: no source given");
    // the installed version's code: not in the cache, and no git commit to fetch it at
    const notCached = `datanotes extension: the installed version's code is not in the cache\nInstall it again from the same folder state, or update from a git source.\nSee ${EXT_DOCS.update}\n`;
    for (const commit of ["local-abc", "../x", 7]) expect((await update([fakeRecord({ commit })], ["--from", BOOKS_V2])).io.err).toBe(notCached);
    expect((await update([fakeRecord({ commit: "b".repeat(40), source: { kind: "git", url: "-x" } })], ["--from", BOOKS_V2])).io.err).toBe(noGit);
  });

  it("apply: a refused batch writes nothing else", async () => {
    const seen: string[] = [];
    const transport = intercept((req) => {
      seen.push(req.url);
      return req.url === operation("batch") ? json(400, { error: "the test refuses this batch" }) : undefined;
    });
    const r = await install("13", { transport });
    expect(r.code).toBe(1);
    expect(r.io.err).toBe("datanotes extension: the test refuses this batch\n");
    expect(seen).not.toContain(route("/tokens/create/"));
    const j = await install("13", { transport, extra: ["--json"] });
    expect(JSON.parse(j.io.out)).toEqual({ error: "the test refuses this batch" });
    expect(await token()).toBeUndefined();
    expect(await record()).toBeUndefined();
  });

  it("apply: a failed token creation undoes the batch", async () => {
    let undone: unknown;
    const transport = intercept((req) => {
      if (req.url === route("/tokens/create/")) return json(500, { error: "token store broke" });
      if (req.url === operation("undo_migration")) undone = JSON.parse(req.body!).migration_id;
      return undefined;
    });
    const r = await install("14", { transport });
    expect(r.code).toBe(1);
    expect(r.io.err).toBe("datanotes extension: token store broke\nRolled back: nothing of this install is left.\n");
    expect(typeof undone).toBe("string");
    const batches = await vault.ok("list_migrations", { op: "batch", limit: 1000 });
    expect(batches.migrations.find((m: any) => m.migration_id === undone)?.undone).toBe(true);
    expect(await tableGone("e14.books.book")).toBe(true);
    expect(await token()).toBeUndefined();
  });

  it("apply: a failed record write deletes the token and its file and undoes the batch", async () => {
    let wrote = false;
    const transport = intercept((req) => {
      if (req.url === route("/extensions/record/")) {
        wrote = fs.existsSync(file());
        return json(500, { error: "registry broke" });
      }
      return undefined;
    });
    const r = await install("15", { transport, extra: ["--json"] });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.io.out)).toEqual({ error: "registry broke", rolled_back: true });
    expect(wrote).toBe(true);
    expect(await token()).toBeUndefined();
    expect(fs.existsSync(file())).toBe(false);
    expect(await tableGone("e15.books.book")).toBe(true);
    expect(await record()).toBeUndefined();
  });

  it("apply: a failed record write after a token update puts the write patterns back", async () => {
    expect((await install("16")).code).toBe(0);
    const wider = copyOf(BOOKS_V2, "wider-16", (m) => (m.permissions.write = ["book", "person"]));
    const dry = await cli(["update", "books", ...conn(), "--from", wider, "--dry-run", "--json"]);
    expect(JSON.parse(dry.io.out).token.action).toBe("update");
    const transport = intercept((req) => (req.url === route("/extensions/record/") ? json(500, { error: "registry broke" }) : undefined));
    const r = await cli(["update", "books", ...conn(), "--from", wider, "--yes"], { transport });
    expect(r.code).toBe(1);
    expect(r.io.err).toBe("datanotes extension: registry broke\nRolled back: nothing of this update is left.\n");
    expect((await token())?.write).toEqual(["e16.books.book"]);
    const book = await vault.ok("describe_table", { table: "e16.books.book" });
    expect(book.columns.map((c: any) => c.name)).not.toContain("finished_on");
    expect((await record())?.version).toBe("0.1.0");
  });

  it("apply: an undo that fails too says what is left", async () => {
    let batch = "";
    const transport = intercept(async (req) => {
      if (req.url === operation("batch")) {
        const res = await fetchTransport(req);
        batch = JSON.parse(res.text).migration_id;
        return res;
      }
      if (req.url === route("/tokens/create/")) return json(500, { error: "token store broke" });
      if (req.url === operation("undo_migration")) return json(500, { error: "journal broke" });
      return undefined;
    });
    const r = await install("17", { transport });
    expect(r.code).toBe(1);
    expect(r.io.err).toBe(`datanotes extension: token store broke\nCould not roll back: left the batch ${batch}; undo the batch with undo_migration ${batch}.\n`);
    await vault.ok("undo_migration", { migration_id: batch });
  });

  it("apply: each undo step that fails is named", async () => {
    // the token file cannot be written, nor removed: a folder stands in its place
    fs.mkdirSync(file(), { recursive: true });
    try {
      const r = await install("17a");
      expect(r.code).toBe(1);
      expect(r.io.err.split("\n")[1]).toBe(`Could not roll back: left the token file ${file()}.`);
      expect(await token()).toBeUndefined();
      expect(await tableGone("e17a.books.book")).toBe(true);
    } finally {
      fs.rmSync(file(), { recursive: true, force: true });
    }
    // the record and then the token's deletion fail
    const failing = intercept((req) => (req.url === route("/extensions/record/") || req.url === route("/tokens/delete/") ? json(500, { error: "broke" }) : undefined));
    const left = await install("17b", { transport: failing, extra: ["--json"] });
    expect(JSON.parse(left.io.out)).toEqual({ error: "broke", rolled_back: false, left: ["the token ext-books"] });
    expect(await tableGone("e17b.books.book")).toBe(true);
    await owner.post("/tokens/delete/", { name: "ext-books" });
    removeTokenFile(file());
    // a token update that fails: its revert fails too
    expect((await install("17c")).code).toBe(0);
    const wider = copyOf(BOOKS_V2, "wider-17c", (m) => (m.permissions.write = ["book", "person"]));
    const noUpdate = intercept((req) => (req.url === route("/tokens/update/") ? json(500, { error: "tokens broke" }) : undefined));
    const patterns = await cli(["update", "books", ...conn(), "--from", wider, "--yes"], { transport: noUpdate });
    expect(patterns.io.err).toBe("datanotes extension: tokens broke\nCould not roll back: left the token's write patterns.\n");
    expect((await vault.ok("describe_table", { table: "e17c.books.book" })).columns.map((c: any) => c.name)).not.toContain("finished_on");
  });

  it("apply: a rotation that fails afterwards keeps its new secret in the token file, and says so (R4-Q3)", async () => {
    expect((await install("27")).code).toBe(0);
    const before = await record();
    // without its token file, installing again is a repair that rotates the token
    removeTokenFile(file());
    const dry = await install("27", { extra: ["--dry-run", "--json"], yes: false });
    expect(JSON.parse(dry.io.out).token.action).toBe("rotate");
    // the first /tokens/update/ (right after the rotation) fails; the undo's own update goes through
    const updateFailsOnce = (): Transport => {
      let failed = false;
      return intercept((req) => {
        if (req.url !== route("/tokens/update/") || failed) return undefined;
        failed = true;
        return json(500, { error: "tokens broke" });
      });
    };
    const kept = `the token ext-books with a new secret, kept in ${file()}`;
    const r = await install("27", { transport: updateFailsOnce() });
    expect(r.code).toBe(1);
    expect(r.io.err).toBe(`datanotes extension: tokens broke\nCould not roll back: left ${kept}.\n`);
    // the engine forgot the old secret: the file holds the new one, and the engine takes it
    const secret = fs.readFileSync(file(), "utf8").trim();
    expect((await new DatanotesClient({ url: url(), token: secret }).call("select_rows", { table: "e27.books.book" })).ok).toBe(true);
    expect((await token())?.write).toEqual(["e27.books.book"]);
    expect(await record()).toEqual(before);
    // the same in JSON
    removeTokenFile(file());
    const j = await install("27", { transport: updateFailsOnce(), extra: ["--json"] });
    expect(j.code).toBe(1);
    expect(JSON.parse(j.io.out)).toEqual({ error: "tokens broke", rolled_back: false, left: [kept] });
    expect(fs.existsSync(file())).toBe(true);
  });

  it("rollback skips a batch undone by hand", async () => {
    expect((await install("18")).code).toBe(0);
    const first = (await record())!.migration_id!;
    await vault.ok("undo_migration", { migration_id: first });
    const seen: string[] = [];
    const watch = intercept((req) => void seen.push(req.url));
    const r = await cli(["rollback", "books", ...conn(), "--yes"], { transport: watch });
    expect(r.code).toBe(0);
    expect(r.io.out).toContain(`The batch ${first} was undone already.\n`);
    expect(seen).not.toContain(operation("undo_migration"));
    expect(await record()).toBeUndefined();

    expect((await install("18b")).code).toBe(0);
    const second = (await record())!.migration_id!;
    await vault.ok("undo_migration", { migration_id: second });
    // a journal that no longer lists it: the engine's refusal of the undo says the same
    const forgetful = intercept((req) => (req.url === operation("list_migrations") ? json(200, { migrations: [] }) : undefined));
    const again = await cli(["rollback", "books", ...conn(), "--yes"], { transport: forgetful });
    expect(again.code).toBe(0);
    expect(again.io.out).toContain(`The batch ${second} was undone already.\n`);
    expect(await record()).toBeUndefined();
  });

  it("a rollback that fails after the undo says to run it again, and the next run finishes", async () => {
    expect((await install("19")).code).toBe(0);
    expect((await cli(["update", "books", ...conn(), "--from", BOOKS_V2, "--yes"])).code).toBe(0);
    const batch = (await record())!.migration_id!;
    let failed = false;
    const once = intercept((req) => {
      if (req.url !== route("/extensions/record/") || failed) return undefined;
      failed = true;
      return json(500, { error: "registry broke" });
    });
    const r = await cli(["rollback", "books", ...conn(), "--yes"], { transport: once });
    expect(r.code).toBe(1);
    expect(r.io.err).toBe(`datanotes extension: registry broke\nThe batch ${batch} is undone; run datanotes extension rollback books again to finish.\n`);
    const j = await cli(["rollback", "books", ...conn(), "--yes", "--json"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.io.out)).toEqual({ rolled_back: { name: "books", from_version: "0.2.0", to_version: "0.1.0", undone: batch, removed: false } });
    expect((await record())?.version).toBe("0.1.0");
  });

  it("rollback: a refused undo, a failure without a batch, and a confirmation in JSON", async () => {
    expect((await install("19b")).code).toBe(0);
    const refuses = intercept((req) => (req.url === operation("undo_migration") ? json(409, { error: "the test refuses the undo" }) : undefined));
    const refused = await cli(["rollback", "books", ...conn(), "--yes"], { transport: refuses });
    expect(refused.code).toBe(1);
    expect(refused.io.err).toBe("datanotes extension: the test refuses the undo\n");
    expect((await record())?.migration_id).not.toBeNull();

    const repaired = fakeRecord({ migration_id: null, previous: fakeRecord({}) });
    const noToken = withRecords([repaired], (req) => (req.url === route("/tokens/update/") ? json(500, { error: "tokens broke" }) : undefined));
    const plain = await cli(["rollback", "books", ...conn(), "--yes"], { transport: noToken });
    expect(plain.code).toBe(1);
    expect(plain.io.err).toBe("datanotes extension: tokens broke\n");
    const ask = await cli(["rollback", "books", ...conn(), "--json"], { transport: withRecords([repaired]) });
    expect(ask.code).toBe(3);
    expect(JSON.parse(ask.io.out)).toEqual({ rollback: { name: "books", version: "0.1.0", migration_id: null, to_version: "0.1.0" }, confirmation_needed: true });
    const missing = await cli(["rollback", "zzz", ...conn()]);
    expect(missing.io.err).toBe(`datanotes extension: zzz is not installed\ndatanotes extension list shows what is installed; install it first.\nSee ${EXT_DOCS.rollback}\n`);
  });

  it("remove without a record deletes what an earlier install left", async () => {
    await owner.post("/tokens/create/", { name: "ext-books" });
    writeTokenFile(file(), "an-old-secret");
    const r = await cli(["remove", "books", ...conn(), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.io.out).toBe("Removed what an earlier install of books left.\n");
    expect(await token()).toBeUndefined();
    expect(fs.existsSync(file())).toBe(false);
    // the file alone
    writeTokenFile(file(), "an-old-secret");
    const ask = await cli(["remove", "books", ...conn(), "--json"]);
    expect(ask.code).toBe(3);
    expect(JSON.parse(ask.io.out)).toEqual({ remove: { name: "books", leftovers: true }, confirmation_needed: true });
    const j = await cli(["remove", "books", ...conn(), "--yes", "--json"]);
    expect(JSON.parse(j.io.out)).toEqual({ removed: { name: "books", tables: [], migration_id: null, leftovers: true } });
    expect(fs.existsSync(file())).toBe(false);
  });

  it("remove of a name never installed", async () => {
    const r = await cli(["remove", "zzz", ...conn(), "--yes"]);
    expect(r.code).toBe(1);
    expect(r.io.err).toBe(`datanotes extension: zzz is not installed\ndatanotes extension list shows what is installed.\nSee ${EXT_DOCS.remove}\n`);
  });

  it("remove: a confirmation in JSON, a table already gone, the JSON answer", async () => {
    expect((await install("20b")).code).toBe(0);
    const ask = await cli(["remove", "books", ...conn(), "--json"]);
    expect(ask.code).toBe(3);
    expect(JSON.parse(ask.io.out)).toEqual({ remove: { name: "books", version: "0.1.0", tables: ["e20b.books.book"] }, confirmation_needed: true });
    await vault.ok("drop_table", { table: "e20b.books.book" });
    const r = await cli(["remove", "books", ...conn(), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.io.out.endsWith("Removed books. Its tables stay: e20b.books.book.\n")).toBe(true);

    expect((await install("20c")).code).toBe(0);
    const j = await cli(["remove", "books", ...conn(), "--yes", "--json"]);
    const removed = JSON.parse(j.io.out).removed;
    expect(removed).toMatchObject({ name: "books", tables: ["e20c.books.book"] });
    expect(typeof removed.migration_id).toBe("string");
    const refuses = intercept((req) => (req.url === operation("batch") ? json(400, { error: "no tag change today" }) : undefined));
    expect((await install("20d")).code).toBe(0);
    const refused = await cli(["remove", "books", ...conn(), "--yes"], { transport: refuses });
    expect(refused.code).toBe(1);
    expect(refused.io.err).toBe("datanotes extension: no tag change today\n");
    expect(await record()).toBeDefined();
  });

  it("rollback and remove refuse a record whose token is not ext-<name>, before any write (R4-Q4)", async () => {
    // another agent's token, which a hand-written record names
    await owner.post("/tokens/create/", { name: "claude" });
    try {
      const hint = 'datanotes extension install writes only records whose token is ext-books. Delete this one (POST /datanotes/extensions/delete/ with {"name": "books"}, owner only), then run datanotes extension remove books.';
      for (const named of ["claude", 7]) {
        const message = `the record of books names the token ${String(named)}, not ext-books`;
        const seen: string[] = [];
        const transport = withRecords([fakeRecord({ token: named })], (req) => void seen.push(req.url));
        const rolled = await cli(["rollback", "books", ...conn(), "--yes"], { transport });
        expect(rolled.code).toBe(1);
        expect(rolled.io.out).toBe("");
        expect(rolled.io.err).toBe(`datanotes extension: ${message}\n${hint}\nSee ${EXT_DOCS.remove}\n`);
        const removed = await cli(["remove", "books", ...conn(), "--yes", "--json"], { transport });
        expect(removed.code).toBe(1);
        expect(JSON.parse(removed.io.out)).toEqual({ error: message, hint, docs: EXT_DOCS.remove });
        // only the connection's reads reached the engine: the registry (answered here) and /tokens/, once per command
        expect(seen).toEqual([route("/tokens/"), route("/tokens/")]);
      }
      expect((await owner.post<{ tokens: { name: string }[] }>("/tokens/", {})).tokens.map((t) => t.name)).toContain("claude");
    } finally {
      await owner.post("/tokens/delete/", { name: "claude" });
    }
  });

  it("list shows what this machine misses", async () => {
    expect((await cli(["list", ...conn()])).io.out).toBe("No extension is installed.\n");
    expect((await install("22")).code).toBe(0);
    const r = (await record())!;
    fs.rmSync(codeDir(home, "books", r.commit), { recursive: true, force: true });
    removeTokenFile(file());
    await vault.ok("undo_migration", { migration_id: r.migration_id });
    const listed = await cli(["list", ...conn()]);
    const label = BOOKS_V1.split("\\").join("/");
    expect(listed.io.out.split("\n").slice(4)).toEqual([
      "  this machine: code no, token no",
      `  repair: datanotes extension install ${label}`,
      `  the batch ${r.migration_id} was undone by hand: run datanotes extension rollback books to bring the record in step`,
      "",
    ]);
    const j = JSON.parse((await cli(["list", ...conn(), "--json"])).io.out);
    expect(j.extensions[0]).toMatchObject({ local: { code: false, token: false }, undone: true });

    // records this machine cannot build a path from, and a git one that writes nothing
    const records = [fakeRecord({ name: "gitbook", write: [] }), fakeRecord({ name: 5 }), fakeRecord({ name: "books3", commit: 7 })];
    const odd = await cli(["list", ...conn()], { transport: withRecords(records) });
    expect(odd.code).toBe(0);
    const blocks = odd.io.out.split("\n\n");
    expect(blocks[0]!.split("\n")).toEqual([
      `gitbook 0.1.0  git https://example.com/team/books.git#v0.1.0 (${"a".repeat(12)})`,
      "  tables: person work.planning.person, book work.books.book (own)",
      "  tools: list_reading, finish_book",
      "  token: ext-books, writes nothing",
      "  this machine: code no, token no",
      "  repair: datanotes extension install https://example.com/team/books.git#v0.1.0",
    ]);
    expect(blocks[1]).toContain("5 0.1.0  git");
    expect(blocks[2]).toContain("books3 0.1.0  git https://example.com/team/books.git#v0.1.0 (7)");
    const refused = await cli(["list", ...conn()], { transport: intercept((req) => (req.url === operation("list_migrations") ? json(400, { error: "no journal" }) : undefined)) });
    expect(refused.io.err).toBe("datanotes extension: no journal\n");
  });

  it("nodeIo reads the answer from its input, and knows a terminal", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const io = nodeIo({ stdin, stdout, stderr });
    expect(io.isTTY).toBe(false);
    const answer = io.ask("Type yes to go on: ");
    stdin.write("yes\n");
    expect(await answer).toBe("yes");
    expect(String(stdout.read())).toBe("Type yes to go on: ");
    io.stderr.write("an error\n");
    expect(String(stderr.read())).toBe("an error\n");
    const tty = nodeIo({ stdin: Object.assign(new PassThrough(), { isTTY: true }), stdout: Object.assign(new PassThrough(), { isTTY: true }), stderr });
    expect(tty.isTTY).toBe(true);
    expect(nodeIo({ stdin: Object.assign(new PassThrough(), { isTTY: true }), stdout, stderr }).isTTY).toBe(false);
    expect(typeof nodeIo().isTTY).toBe("boolean");
  });

  it("the confirmation question of update and rollback", async () => {
    expect((await install("24")).code).toBe(0);
    const update = await cli(["update", "books", ...conn(), "--from", BOOKS_V2], { tty: true, answers: ["n"] });
    expect(update.code).toBe(1);
    expect(update.io.questions).toEqual(["Update books from 0.1.0 to 0.2.0 with this plan? Type yes to go on: "]);
    expect(update.io.out.endsWith("Cancelled: nothing was written.\n")).toBe(true);
    const rollback = await cli(["rollback", "books", ...conn()], { tty: true, answers: ["n"] });
    expect(rollback.code).toBe(1);
    expect(rollback.io.questions).toEqual(["Roll back books 0.1.0? Type yes to go on: "]);
    // a repair (the token file is gone) asks too
    removeTokenFile(file());
    const repair = await install("24", { yes: false });
    expect(repair.code).toBe(3);
    const asked = await cli(["install", BOOKS_V1, ...conn(), "--catalog", "e24", "--map", "person=work.planning.person"], { tty: true, answers: ["N"] });
    expect(asked.io.questions).toEqual(["Repair books 0.1.0 with this plan? Type yes to go on: "]);
    const repaired = await cli(["install", BOOKS_V1, ...conn(), "--catalog", "e24", "--map", "person=work.planning.person"], { tty: true, answers: [" YES "] });
    expect(repaired.code).toBe(0);
    expect(repaired.io.out.endsWith("Repaired books 0.1.0. Restart your MCP server (or your MCP client) to load its tools. Undo: datanotes extension rollback books.\n")).toBe(true);
    const removed = await cli(["remove", "books", ...conn()], { tty: true, answers: ["y"] });
    expect(removed.code).toBe(0);
    expect(removed.io.questions).toEqual(["Remove books? Type yes to go on: "]);
  });

  it("a dry run in text, and a repair with nothing to do in JSON", async () => {
    const dry = await install("25", { extra: ["--dry-run"], yes: false });
    expect(dry.code).toBe(0);
    // the base shelved may be there already, from an earlier test
    expect(dry.io.out).toMatch(/\nbooks 0\.1\.0: 1 created, 0 adopted, 1 matched; \d+ operations in one batch\n$/);
    expect(await record()).toBeUndefined();
    expect((await install("25")).code).toBe(0);
    const again = await install("25", { extra: ["--json"] });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.io.out)).toMatchObject({ action: "repair", nothing_to_do: true });
  });

  it("an engine that does not say its version, and a refused read", async () => {
    const root = (text: string) => intercept((req) => (req.method === "GET" && req.url === `${url()}/` ? { status: 200, text } : undefined));
    // no version: a source run, which meets every range
    expect((await install("26", { transport: root(""), extra: ["--dry-run"], yes: false })).code).toBe(0);
    const old = await install("26", { transport: root(JSON.stringify({ version: "3.0.0" })), extra: ["--dry-run"], yes: false });
    expect(old.code).toBe(2);
    expect(old.io.out).toContain("  - the extension needs Datanotes >=3.2.0; the engine is 3.0.0\n");
    const refuses = intercept((req) => (req.url === operation("describe_table") ? json(400, { error: "no describing today" }) : undefined));
    const refused = await install("26", { transport: refuses, extra: ["--dry-run"], yes: false });
    expect(refused.code).toBe(1);
    expect(refused.io.err).toBe("datanotes extension: no describing today\n");
  });

  it("check: a missing heading, no tools page, an entry that throws, JSON answers", async () => {
    const copy = (name: string, edit: (dir: string) => void): string => {
      const dir = path.join(tmp, name);
      fs.cpSync(BOOKS_V1, dir, { recursive: true });
      edit(dir);
      return dir;
    };
    const noHeading = copy("check-heading", (dir) => fs.writeFileSync(path.join(dir, "docs", "tools.md"), "# Books tools\r\n\r\n## list_reading\r\n"));
    const heading = await cli(["check", noHeading]);
    expect(heading.code).toBe(2);
    expect(heading.io.out).toBe('- docs/tools.md has no "## finish_book" heading\n');
    const problems = await cli(["check", noHeading, "--json"]);
    expect(JSON.parse(problems.io.out)).toEqual({ ok: false, problems: ['docs/tools.md has no "## finish_book" heading'] });

    const noPage = copy("check-no-page", (dir) => fs.rmSync(path.join(dir, "docs", "tools.md")));
    const ok = await cli(["check", noPage, "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.io.out)).toEqual({ ok: true, name: "books", version: "0.1.0", tools: 2, tables: 2, owned: 1, views: 1, bases: 1 });

    const throws = copy("check-throws", (dir) => fs.writeFileSync(path.join(dir, "lib", "extension.mjs"), 'throw new Error("boom");\n'));
    const broken = await cli(["check", throws]);
    expect(broken.code).toBe(1);
    expect(broken.io.err).toBe(`datanotes extension: the entry did not load: boom\nRun the entry with node to see the error, then build it again.\nSee ${EXT_DOCS.layout}\n`);
    const empty = await cli(["check", path.join(tmp, "nothing-here")]);
    expect(empty.code).toBe(1);
    expect(empty.io.err).toContain("no datanotes-extension.json in");
  });

  it("fills its own io, env and cwd when none are given", async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      written.push(String(s));
      return true;
    });
    try {
      expect(await extensionMain(["frob"])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).toContain('datanotes extension: unknown command "extension frob"');
  });
});
