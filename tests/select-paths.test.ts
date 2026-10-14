/**
 * A filter that pins `path` (`{path: "a.md"}`, `{path: {eq: …}}`, `{path: {in: […]}}`) reads only
 * the notes it names, looked up in the vault index: the answer is the one of a full read.
 */

import { afterEach, describe, expect, it } from "vitest";
import { invalidateFiles, TEXT_CACHE } from "../src/core/file-cache";
import type { TFile } from "../src/core/host";
import { createTable, INDEX_RETRY, pinnedPaths, type LoadedTable } from "../src/core/engine";
import { deleteRows, insertRow, select } from "../src/core/rows";
import { createDbVault, logVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const budget = { ...TEXT_CACHE };
afterEach(() => void Object.assign(TEXT_CACHE, budget));

const COLUMNS = [
  { name: "title", type: "string", required: true },
  { name: "rank", type: "integer" },
];

async function films() {
  const v = createDbVault({ "Notes/plain.md": "No table.\n" });
  expect((await createTable(v.app, v.settings, described({ name: "film", options: { filename: "{title}" }, columns: COLUMNS }))).ok).toBe(true);
  expect((await createTable(v.app, v.settings, described({ name: "book", options: { filename: "{title}" }, columns: COLUMNS }))).ok).toBe(true);
  for (const [i, title] of ["Metropolis", "Nosferatu", "Sunrise", "Vampyr"].entries()) {
    expect((await insertRow(v.app, v.settings, { table: "film", values: { title, rank: i } })).ok).toBe(true);
  }
  expect((await insertRow(v.app, v.settings, { table: "book", values: { title: "Dracula" } })).ok).toBe(true);
  const paths = (await select(v.app, v.settings, { table: "film" })).rows.map((r) => r.path as string);
  const book = (await select(v.app, v.settings, { table: "book" })).rows[0]!.path as string;
  return { v, paths, book };
}

describe("a filter on path", () => {
  it("answers as a full read: the rows named, in order, other conditions applied, other notes left out", async () => {
    const { v, paths, book } = await films();
    const titles = async (where: Record<string, unknown>) => (await select(v.app, v.settings, { table: "film", where, columns: ["title"] })).rows.map((r) => r.title);
    expect(await titles({ path: paths[2] })).toEqual(["Sunrise"]);
    expect(await titles({ path: { eq: paths[0] } })).toEqual(["Metropolis"]);
    // the answer's order, whatever the list's; a path twice counts once
    expect(await titles({ path: { in: [paths[3], paths[1], paths[3]] } })).toEqual(["Nosferatu", "Vampyr"]);
    // a row of another table, a plain note, a note that does not exist: no row of film
    expect(await titles({ path: { in: [book, "Notes/plain.md", "Nowhere/x.md", paths[0]] } })).toEqual(["Metropolis"]);
    expect(await titles({ path: { in: [paths[0], paths[1]] }, rank: { gte: 1 } })).toEqual(["Nosferatu"]);
    expect(await titles({ path: { in: [] } })).toEqual([]);
    // a row archived since: out of the table
    expect((await deleteRows(v.app, v.settings, { table: "film", where: { path: paths[1] } })).ok).toBe(true);
    expect(await titles({ path: { in: paths } })).toEqual(["Metropolis", "Sunrise", "Vampyr"]);
    expect((await select(v.app, v.settings, { table: "film" })).total).toBe(3);
  });

  it("reads only the front matter of the notes named: no text while the cache holds their parse", async () => {
    // the Node host follows the vault's events: the vault index looks the paths up
    const v = logVault({}, "node");
    TEXT_CACHE.maxChars = 0; // no text kept: a read that needs one reads the note again
    invalidateFiles(v.app, ["Daily/a.md", "Daily/b.md"]);
    expect((await select(v.app, v.settings, { table: "log" })).total).toBe(2);
    const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
    const real = vault.read.bind(vault);
    const reads: string[] = [];
    vault.read = async (f) => (reads.push(f.path), real(f));
    const kinds = (await select(v.app, v.settings, { table: "log", where: { path: { in: ["Daily/b.md", "Daily/a.md"] } }, columns: ["kind"] })).rows.map((r) => r.kind);
    expect(kinds).toEqual(["alcohol", "mood"]);
    expect(reads.filter((p) => p.startsWith("Daily/"))).toEqual([]);
    // the body, when asked for, is read from the note
    const withBody = await select(v.app, v.settings, { table: "log", where: { path: "Daily/b.md" }, includeBody: true });
    expect(withBody.rows.map((r) => r.body)).toEqual(["B\n"]);
  });

  it("is pinned only by a top-level path of plain strings, on a table without a column named path", () => {
    const t = { def: { columns: [] } } as unknown as LoadedTable;
    expect(pinnedPaths({ path: "a.md" }, t)).toEqual(["a.md"]);
    expect(pinnedPaths({ path: { in: ["a.md", "b.md"] } }, t)).toEqual(["a.md", "b.md"]);
    for (const where of [undefined, {}, { rank: 1 }, { path: { ne: "a.md" } }, { path: { eq: "a.md", ne: "b.md" } }, { path: { in: ["{this.path}"] } }, { path: { in: [1] } }, { path: { in: "a.md" } }, { or: [{ path: "a.md" }] }]) {
      expect(pinnedPaths(where, t), JSON.stringify(where)).toBeNull();
    }
    expect(pinnedPaths({ path: "a.md" }, { def: { columns: [{ name: "path" }] } } as unknown as LoadedTable)).toBeNull();
  });
});
