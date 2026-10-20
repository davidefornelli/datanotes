/**
 * `datanotes extension` (src/node/extension-command.ts) on real engines: the `books` fixture extension
 * installed, listed, repaired, updated, rolled back and removed through the command, as a user's agent
 * runs it. The cases of the first describe build on each other, in order, on one vault.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatanotesClient, DatanotesError } from "../src/api/client";
import { codeDir, extensionsHome, fileSha256, readTokenFile, tokenPath } from "../src/api/extension-files";
import type { InstalledExtension } from "../src/api/extension-record";
import { extensionMain, type ExtensionIo } from "../src/node/extension-command";
import { runGit } from "../src/node/git-sync";
import { BOOKS_V1, BOOKS_V2 } from "./helpers/extensions";
import { openTestVault, type TestVault } from "./helpers/test-vault";

interface FakeIo extends ExtensionIo {
  out: string;
  err: string;
  questions: string[];
}

/** An io that collects what the command prints and answers its questions from a queue. */
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

/** Run the command; the exit code and what it printed. */
async function cli(argv: string[], o: { tty?: boolean; answers?: string[] } = {}): Promise<{ code: number; io: FakeIo }> {
  const io = fakeIo(o);
  const code = await extensionMain(argv, { io, env: process.env, cwd: os.tmpdir() });
  return { code, io };
}

const lastLine = (text: string): string => {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1]!;
};

async function registry(v: TestVault): Promise<{ database_id: string; extensions: InstalledExtension[] }> {
  return v.client.post("/extensions/", {});
}
async function tokenNames(v: TestVault): Promise<{ name: string; write?: string[] }[]> {
  return (await v.client.post<{ tokens: { name: string; write?: string[] }[] }>("/tokens/", {})).tokens;
}
async function books(v: TestVault): Promise<InstalledExtension | undefined> {
  return (await registry(v)).extensions.find((r) => r.name === "books");
}

describe("install, list, update, rollback and remove on one vault", { timeout: 60_000 }, () => {
  let vault: TestVault;
  let root: string;
  let databaseId: string;
  const file = () => tokenPath(extensionsHome(), databaseId, "books");

  beforeAll(async () => {
    vault = await openTestVault("service");
    root = vault.root;
    databaseId = (await registry(vault)).database_id;
  }, 60_000);
  afterAll(async () => {
    await vault?.stop();
  });

  it("a dry run shows the plan and writes nothing", async () => {
    const { code, io } = await cli(["install", BOOKS_V1, "--vault", root, "--dry-run", "--json"]);
    expect(code).toBe(0);
    const plan = JSON.parse(io.out);
    expect(plan.tables.map((t: any) => [t.role, t.table, t.decision, t.proposed])).toEqual([
      ["person", "work.planning.person", "match", true],
      ["book", "work.books.book", "create", false],
    ]);
    expect(plan.operations.map((o: any) => o.op)).toEqual(["define_base", "create_table", "set_table_bases", "add_constraint", "create_view"]);
    expect(plan.token.action).toBe("create");
    expect(io.err).toBe("");
    expect(await vault.refused("describe_table", { table: "work.books.book" })).toContain("work.books.book");
    expect((await tokenNames(vault)).map((t) => t.name)).not.toContain("ext-books");
    expect((await registry(vault)).extensions).toEqual([]);
  });

  it("without a terminal and without --yes it asks for confirmation", async () => {
    const text = await cli(["install", BOOKS_V1, "--vault", root]);
    expect(text.code).toBe(3);
    expect(text.io.out).toContain("Install books 0.1.0: A reading list");
    expect(text.io.err).toBe("datanotes extension: confirmation needed: run the command again with --yes once the user approved the plan\n");
    const json = await cli(["install", BOOKS_V1, "--vault", root, "--json"]);
    expect(json.code).toBe(3);
    const payload = JSON.parse(json.io.out);
    expect(payload.confirmation_needed).toBe(true);
    expect(payload.ready).toBe(true);
    expect(text.io.questions).toEqual([]);
    expect(json.io.questions).toEqual([]);
    expect((await registry(vault)).extensions).toEqual([]);
    expect(await vault.refused("describe_table", { table: "work.books.book" })).toContain("work.books.book");
  });

  it("a terminal that answers no cancels", async () => {
    const { code, io } = await cli(["install", BOOKS_V1, "--vault", root], { tty: true, answers: ["no"] });
    expect(code).toBe(1);
    expect(lastLine(io.out)).toBe("Cancelled: nothing was written.");
    expect(io.questions).toEqual(["Install books 0.1.0 with this plan? Type yes to go on: "]);
    expect((await registry(vault)).extensions).toEqual([]);
  });

  it("install writes the batch, the token, its file and the record", async () => {
    const { code, io } = await cli(["install", BOOKS_V1, "--vault", root, "--yes"]);
    expect(code).toBe(0);
    expect(lastLine(io.out)).toBe("Installed books 0.1.0. Restart your MCP server (or your MCP client) to load its tools. Undo: datanotes extension rollback books.");
    const book = await vault.ok("describe_table", { table: "work.books.book" });
    expect(book.tags).toEqual({ extension: "books", extension_role: "book" });
    expect(book.instructions).toContain("How to add a book");
    expect(Object.keys(book.constraints)).toContain("rating_only_when_read");
    const listed = await vault.ok("list_tables");
    expect(listed.views.map((v: any) => v.qualified)).toContain("work.books.vw_reading");
    const token = (await tokenNames(vault)).find((t) => t.name === "ext-books");
    expect(token?.write).toEqual(["work.books.book"]);
    const secret = readTokenFile(file());
    expect(secret).not.toBeNull();
    expect(io.out).not.toContain(secret!);
    const ext = new DatanotesClient({ url: vault.client.url, token: secret! });
    expect((await ext.call("select_rows", { table: "work.books.book" })).ok).toBe(true);
    const r = (await books(vault))!;
    const batches = await vault.ok("list_migrations", { op: "batch", limit: 1000 });
    expect(batches.migrations.map((m: any) => m.migration_id)).toContain(r.migration_id);
    expect(r.tables).toEqual({ person: { table: "work.planning.person", owned: false }, book: { table: "work.books.book", owned: true } });
    expect(r.tools).toEqual(["list_reading", "finish_book"]);
    const dir = codeDir(extensionsHome(), "books", r.commit);
    expect(r.manifest_sha256).toBe(fileSha256(path.join(dir, "datanotes-extension.json")));
    expect(r.entry_sha256).toBe(fileSha256(path.join(dir, "lib", "extension.mjs")));
    expect(r.source).toEqual({ kind: "local", path: BOOKS_V1.split("\\").join("/") });
    expect(r.previous).toBeNull();
  });

  it("list shows it", async () => {
    const r = (await books(vault))!;
    const { code, io } = await cli(["list", "--vault", root]);
    expect(code).toBe(0);
    const label = BOOKS_V1.split("\\").join("/");
    expect(io.out).toBe(
      [
        `books 0.1.0  local ${label} (${r.commit})`,
        "  tables: person work.planning.person, book work.books.book (own)",
        "  tools: list_reading, finish_book",
        "  token: ext-books, writes work.books.book",
        "  this machine: code yes, token yes",
        "",
      ].join("\n"),
    );
    const json = await cli(["list", "--vault", root, "--json"]);
    const listed = JSON.parse(json.io.out);
    expect(listed.database_id).toBe(databaseId);
    expect(listed.extensions[0]).toMatchObject({ name: "books", local: { code: true, token: true }, undone: false });
  });

  it("installing again repairs nothing, and a missing token file rotates the token", async () => {
    const again = await cli(["install", BOOKS_V1, "--vault", root, "--yes"]);
    expect(again.code).toBe(0);
    expect(lastLine(again.io.out)).toBe("Nothing to repair: books 0.1.0 is installed as planned.");
    const old = readTokenFile(file())!;
    fs.rmSync(file());
    const repair = await cli(["install", BOOKS_V1, "--vault", root, "--yes", "--json"]);
    expect(repair.code).toBe(0);
    const done = JSON.parse(repair.io.out);
    expect(done.plan.action).toBe("repair");
    expect(done.plan.token.action).toBe("rotate");
    expect(done.applied).toEqual({ migration_id: null, token: "rotate", record: true });
    const fresh = readTokenFile(file())!;
    expect(fresh).not.toBe(old);
    expect(repair.io.out).not.toContain(fresh);
    const refused = await new DatanotesClient({ url: vault.client.url, token: old }).call("select_rows", { table: "work.books.book" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DatanotesError);
    expect((refused as DatanotesError).kind).toBe("auth");
    expect((await new DatanotesClient({ url: vault.client.url, token: fresh }).call("select_rows", { table: "work.books.book" })).ok).toBe(true);
    const r = (await books(vault))!;
    expect(r.previous?.version).toBe("0.1.0");
    expect(r.migration_id).toBeNull();
  });

  it("update runs the migration and keeps the history", async () => {
    const before = (await books(vault))!;
    const { code, io } = await cli(["update", "books", "--from", BOOKS_V2, "--vault", root, "--yes"]);
    expect(code).toBe(0);
    expect(io.out).toContain("Update books 0.2.0 (from 0.1.0)");
    expect(lastLine(io.out)).toBe("Updated books to 0.2.0. Restart your MCP server (or your MCP client) to load its tools. Undo: datanotes extension rollback books.");
    const book = await vault.ok("describe_table", { table: "work.books.book" });
    expect(book.columns.map((c: any) => c.name)).toContain("finished_on");
    expect(book.constraint_hints.rating_only_when_read).toBe("Rate a book only once it is read: set status read first, or remove rating.");
    const r = (await books(vault))!;
    expect(r.version).toBe("0.2.0");
    expect(typeof r.migration_id).toBe("string");
    expect(r.previous?.version).toBe("0.1.0");
    expect(r.previous?.migration_id).toBeNull();
    expect(r.previous?.previous?.migration_id).toBe(before.previous!.migration_id);
  });

  it("rollback goes back one record at a time, then undoes the install", async () => {
    const first = await cli(["rollback", "books", "--vault", root, "--yes"]);
    expect(first.code).toBe(0);
    expect(first.io.out).toContain("Rolled back books to 0.1.0.");
    const book = await vault.ok("describe_table", { table: "work.books.book" });
    expect(book.columns.map((c: any) => c.name)).not.toContain("finished_on");
    let r = (await books(vault))!;
    expect(r.version).toBe("0.1.0");
    expect(r.migration_id).toBeNull();
    const install = r.previous!.migration_id;

    const second = await cli(["rollback", "books", "--vault", root, "--yes", "--json"]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.io.out)).toEqual({ rolled_back: { name: "books", from_version: "0.1.0", to_version: "0.1.0", undone: null, removed: false } });
    r = (await books(vault))!;
    expect(r.migration_id).toBe(install);
    expect(r.previous).toBeNull();

    const shown = await cli(["rollback", "books", "--vault", root]);
    expect(shown.code).toBe(3);
    expect(shown.io.out).toBe(`Roll back books 0.1.0: undo batch ${install}; then remove its token, its token file and its record.\n`);
    const third = await cli(["rollback", "books", "--vault", root, "--yes"]);
    expect(third.code).toBe(0);
    expect(lastLine(third.io.out)).toBe("Rolled back the install of books: its token and record are gone.");
    expect(await vault.refused("describe_table", { table: "work.books.book" })).toContain("work.books.book");
    expect((await tokenNames(vault)).map((t) => t.name)).not.toContain("ext-books");
    expect(fs.existsSync(file())).toBe(false);
    expect((await registry(vault)).extensions).toEqual([]);
  });

  it("remove keeps the tables", async () => {
    expect((await cli(["install", BOOKS_V1, "--vault", root, "--yes"])).code).toBe(0);
    await vault.ok("insert_row", { table: "work.books.book", values: { title: "The Quiet Shelf" } });
    const { code, io } = await cli(["remove", "books", "--vault", root, "--yes"]);
    expect(code).toBe(0);
    expect(io.out).toContain("Remove books 0.1.0: keep its tables (work.books.book); remove their extension tags, the token ext-books, its file on this machine and the record.");
    expect(lastLine(io.out)).toMatch(/^Removed books\. Its tables stay: work\.books\.book\. Undo the tag change with undo_migration \S+\.$/);
    const book = await vault.ok("describe_table", { table: "work.books.book" });
    expect(book.tags?.extension).toBeUndefined();
    const rows = await vault.ok("select_rows", { table: "work.books.book" });
    expect(rows.rows.map((x: any) => x.title)).toEqual(["The Quiet Shelf"]);
    expect((await tokenNames(vault)).map((t) => t.name)).not.toContain("ext-books");
    expect(fs.existsSync(file())).toBe(false);
    expect((await registry(vault)).extensions).toEqual([]);
    const again = await cli(["remove", "books", "--vault", root, "--yes"]);
    expect(again.code).toBe(1);
    expect(again.io.err.startsWith("datanotes extension: books is not installed")).toBe(true);
  });
});

describe("a git source pinned to a tag", { timeout: 120_000 }, () => {
  let vault: TestVault;
  let tmp: string;
  beforeAll(async () => {
    vault = await openTestVault("service");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-ext-cmd-git-"));
  }, 60_000);
  afterAll(async () => {
    await vault?.stop();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("installs the tag, then updates to the newest one", async () => {
    const repo = path.join(tmp, "books");
    fs.mkdirSync(repo);
    const git = async (...args: string[]): Promise<string> => {
      const r = await runGit(["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], repo);
      if (r.code !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    await git("init", "-q", "-b", "main");
    fs.cpSync(BOOKS_V1, repo, { recursive: true });
    await git("add", "-A");
    await git("commit", "-q", "-m", "v0.1.0");
    await git("tag", "v0.1.0");
    fs.cpSync(BOOKS_V2, repo, { recursive: true });
    await git("add", "-A");
    await git("commit", "-q", "-m", "v0.2.0");
    await git("tag", "v0.2.0");
    const url = pathToFileURL(repo).href;

    const installed = await cli(["install", `${url}#v0.1.0`, "--vault", vault.root, "--yes"]);
    expect(installed.code).toBe(0);
    let r = (await books(vault))!;
    expect(r.source).toEqual({ kind: "git", url, ref: "v0.1.0" });
    expect(r.commit).toBe(await git("rev-parse", "v0.1.0"));
    // the installed version's code gone from this machine: update fetches it again at its commit
    fs.rmSync(codeDir(extensionsHome(), "books", r.commit), { recursive: true, force: true });

    const updated = await cli(["update", "books", "--vault", vault.root, "--yes"]);
    expect(updated.code).toBe(0);
    r = (await books(vault))!;
    expect(r.version).toBe("0.2.0");
    expect(r.source.ref).toBe("v0.2.0");
    expect(r.commit).toBe(await git("rev-parse", "v0.2.0"));
  });
});

describe("choices", { timeout: 60_000 }, () => {
  let vault: TestVault;
  beforeAll(async () => {
    vault = await openTestVault("service");
  }, 60_000);
  afterAll(async () => {
    await vault?.stop();
  });

  it("--map binds a role and a column", async () => {
    const dry = await cli(["install", BOOKS_V1, "--vault", vault.root, "--map", "person=work.planning.person", "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    const plan = JSON.parse(dry.io.out);
    expect(plan.tables[0]).toMatchObject({ role: "person", table: "work.planning.person", decision: "match", proposed: false });
    const done = await cli(["install", BOOKS_V1, "--vault", vault.root, "--map", "person=work.planning.person,person.name=email", "--yes"]);
    expect(done.code).toBe(0);
    expect((await books(vault))!.tables.person!.columns).toEqual({ name: "email" });
  });
});

describe("check", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-ext-cmd-check-"));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  /** A copy of the books fixture (each its own folder: import() caches an entry by its URL). */
  const copy = (name: string, edit: (dir: string) => void): string => {
    const dir = path.join(tmp, name);
    fs.cpSync(BOOKS_V1, dir, { recursive: true });
    edit(dir);
    return dir;
  };

  it("checks an extension's folder: its manifest, its entry and its docs", async () => {
    const ok = await cli(["check", BOOKS_V1]);
    expect(ok.code).toBe(0);
    expect(ok.io.out).toBe("ok: books 0.1.0: 2 tools, 2 tables (1 own), 1 views, 1 bases\n");

    const lacking = copy("lacking", (dir) => {
      const entry = path.join(dir, "lib", "extension.mjs");
      fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("async finish_book(", "async finished_book("));
    });
    const missing = await cli(["check", lacking]);
    expect(missing.code).toBe(2);
    expect(missing.io.out.split("\n")).toContain("- no handler for tool finish_book");

    const named = copy("named", (dir) => {
      const file = path.join(dir, "datanotes-extension.json");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"name": "books"', '"name": "X"'));
    });
    const bad = await cli(["check", named]);
    expect(bad.code).toBe(1);
    expect(bad.io.err.startsWith(`datanotes extension: ${named}/datanotes-extension.json:`)).toBe(true);
    expect(bad.io.err).toContain("name: must be 2 to 40 lowercase letters, digits or -, starting with a letter");
  });
});
