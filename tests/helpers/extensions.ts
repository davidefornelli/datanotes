/**
 * The `books` fixture extension (tests/fixtures/extensions/books) in place as `datanotes extension
 * install` leaves it, without the CLI: its tables, the token `ext-books`, the code in the
 * extensions home, the token file and the registry record. Used by the tests of the extension
 * host, the commands and the MCP server.
 */

import fs from "node:fs";
import path from "node:path";
import { DatanotesClient, DatanotesError } from "../../src/api/client";
import { codeDir, extensionsHome, fileSha256, tokenPath, writeTokenFile } from "../../src/api/extension-files";
import { bindRoles, MANIFEST_FILE, parseManifest } from "../../src/api/extension-manifest";
import type { InstalledExtension } from "../../src/api/extension-record";

export const BOOKS_V1: string = path.resolve(__dirname, "../fixtures/extensions/books/v0.1.0");
export const BOOKS_V2: string = path.resolve(__dirname, "../fixtures/extensions/books/v0.2.0");

export interface FixtureInstall {
  record: InstalledExtension;
  token: string;
  databaseId: string;
  dir: string;
}

/** The tables the person and book roles are bound to. */
const BOUND = { person: "work.planning.person", book: "work.books.book" };

const plain = (columns: { need?: string }[]) => columns.map(({ need: _need, ...column }) => column);
const forward = (p: string): string => p.split(path.sep).join("/");

/**
 * The books fixture as `datanotes extension install` leaves it, without the CLI: its tables through the
 * owner's operations (base shelved, work.books.book, its CHECK, its view), the token ext-books, the code
 * in the extensions home, the token file and the record. The person role is bound to work.planning.person.
 */
export async function installFixture(owner: DatanotesClient, o: { folder?: string; home?: string; commit?: string; createTables?: boolean } = {}): Promise<FixtureInstall> {
  const folder = o.folder ?? BOOKS_V1;
  const home = o.home ?? extensionsHome();
  const manifest = parseManifest(fs.readFileSync(path.join(folder, MANIFEST_FILE), "utf8"));
  const commit = o.commit ?? `local-test-${manifest.version}`;

  const dir = codeDir(home, manifest.name, commit);
  fs.mkdirSync(path.join(dir, path.dirname(manifest.entry)), { recursive: true });
  fs.copyFileSync(path.join(folder, MANIFEST_FILE), path.join(dir, MANIFEST_FILE));
  fs.copyFileSync(path.join(folder, ...manifest.entry.split("/")), path.join(dir, ...manifest.entry.split("/")));
  if (fs.existsSync(path.join(folder, "docs"))) fs.cpSync(path.join(folder, "docs"), path.join(dir, "docs"), { recursive: true });

  let migrationId: string | null = null;
  if (o.createTables !== false) {
    const bound = bindRoles(manifest, BOUND);
    const book = bound.tables.book!;
    const tags = { extension: manifest.name, extension_role: "book" };
    const operations: Record<string, unknown>[] = [
      ...Object.entries(bound.bases).map(([name, b]) => ({ op: "define_base", name, description: b.description, columns: plain(b.columns) })),
      {
        op: "create_table",
        catalog: "work",
        schema: book.schema ?? manifest.default_schema,
        name: book.name ?? "book",
        description: book.description,
        columns: plain(book.columns),
        ...(book.filename ? { filename: book.filename } : {}),
        ...(book.instructions ? { instructions: book.instructions } : {}),
        tags,
      },
      ...(book.bases ? [{ op: "set_table_bases", table: BOUND.book, bases: book.bases }] : []),
      ...(book.constraints ?? []).map((c) => ({ op: "add_constraint", table: BOUND.book, name: c.name, check: c.check, hint: c.hint })),
      ...Object.entries(bound.views).map(([name, v]) => ({ op: "create_view", name, catalog: "work", schema: manifest.default_schema, description: v.description, query: v.query })),
    ];
    const done = await owner.call("batch", { operations, summary: `install ${manifest.name} ${manifest.version}` });
    if (!done.ok) throw new Error(`the fixture's tables were refused: ${String(done.value)}`);
    migrationId = (done.value as { migration_id?: string }).migration_id ?? null;
  }

  // a second install of the same name (an update, a test's second scenario) gets a new secret; any
  // other refusal of the creation is the test's real failure: it is thrown as it is
  const tokenName = `ext-${manifest.name}`;
  const created = await owner.post<{ token: string }>("/tokens/create/", { name: tokenName, write: [BOUND.book] }).catch((e: unknown) => {
    if (e instanceof DatanotesError && e.status === 400 && e.message.includes(`token ${tokenName} already exists`)) {
      return owner.post<{ token: string }>("/tokens/rotate/", { name: tokenName });
    }
    throw e;
  });
  const listed = await owner.post<{ database_id: string | null }>("/extensions/", {});
  const databaseId = listed.database_id ?? "test-database";
  writeTokenFile(tokenPath(home, databaseId, manifest.name), created.token);

  const now = new Date().toISOString();
  const record: InstalledExtension = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    api: manifest.api,
    source: { kind: "local", path: forward(folder) },
    commit,
    manifest_sha256: fileSha256(path.join(dir, MANIFEST_FILE)),
    entry_sha256: fileSha256(path.join(dir, ...manifest.entry.split("/"))),
    token: `ext-${manifest.name}`,
    tables: { person: { table: BOUND.person, owned: false }, book: { table: BOUND.book, owned: true } },
    tools: manifest.tools.map((t) => t.name),
    write: [BOUND.book],
    migration_id: migrationId,
    installed_at: now,
    updated_at: now,
    previous: null,
  };
  await owner.post("/extensions/record/", record);
  return { record, token: created.token, databaseId, dir };
}
