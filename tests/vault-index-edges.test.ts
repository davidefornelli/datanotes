/**
 * The vault index and the indexes built on it, at their edges, on the headless host: a host whose
 * index throws for a note, a folder deleted, a change log that no longer reaches back, a note
 * deleted and created again, a change no event reported (every index tells it), the graph's
 * nodes in a build's order, and the names of a vocabulary.
 */

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { configureDatabase } from "../src/core/database";
import { INDEX_RETRY, loadRows, loadTable } from "../src/core/engine";
import { graphIndex, graphNeighbors } from "../src/core/graph";
import { checkIndexAfter, enableIndexCheck, verifyIndex } from "../src/core/index-check";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { loadMetastore } from "../src/core/metastore";
import { catalogRowFilesOf } from "../src/core/row-files";
import { insertRow } from "../src/core/rows";
import { validationContextFor } from "../src/core/table-registry";
import { currentStates } from "../src/core/transaction-log";
import { uniqueValues } from "../src/core/unique-index";
import { INDEX_LOG, vaultIndex } from "../src/core/vault-index";
import type { TFile } from "../src/core/host";
import type { NodeHost } from "../src/node/node-app";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const PERSON = `person:
  options:
    filename: "{name}"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: name, type: string, required: true, unique: true }
    - { name: buddy, type: string, vocabulary: main.public.person }
    - { name: friend, type: link, ref: main.public.person }
    - { name: friends, type: list, items: link, ref: main.public.person }
    - { name: code, type: string, unique: true }
`;
const P = "Datanotes/main/public/person";
const person = (name: string, extra = "") => `---\ntable: main.public.person\nname: ${name}\n${extra}---\n${name}\n`;

const opened: DbVault[] = [];
afterEach(() => {
  INDEX_LOG.limit = 100_000;
  for (const v of opened.splice(0)) (v.app.metadataCache as unknown as NodeHost["metadataCache"]).dispose();
});

function nodeVault(files: Record<string, string> = {}): DbVault {
  const v = createDbVault({ [METASTORE]: withTables(PERSON), ...files }, {}, { host: "node" });
  opened.push(v);
  return v;
}

const meta = (v: DbVault) => (v.app.metadataCache as unknown as { meta: Map<string, { cache: { frontmatter?: Record<string, unknown> } }> }).meta;

describe("vault index: edges", () => {
  it("names of a vocabulary are kept across writes to another table, read again after a write to their own", async () => {
    const v = nodeVault({ [`${P}/Ada.md`]: person("Ada") });
    await loadMetastore(v.app, v.settings);
    const ctx = validationContextFor(v.app, v.settings, `${P}/x.md`);
    const before = ctx.vocabulary!("main.public.person")!;
    // withTables puts the `log` table (LOG_YAML, tests/helpers/db-vault.ts) next to person
    expect((await insertRow(v.app, v.settings, { table: "log", values: { kind: "walk", occurred_at: "2026-10-01T08:00:00Z" } })).ok).toBe(true);
    expect(ctx.vocabulary!("main.public.person")).toBe(before); // another table's write: the same set
    expect((await insertRow(v.app, v.settings, { table: "person", values: { name: "Bob" } })).ok).toBe(true);
    expect([...ctx.vocabulary!("main.public.person")!].sort()).toEqual(["Ada", "Bob"]);
  });

  it("a host whose index throws for a note: the reads walk the vault (and report it), until it reads again", async () => {
    const v = nodeVault({ [`${P}/Ada.md`]: person("Ada"), [`${P}/Bob.md`]: person("Bob") });
    await loadMetastore(v.app, v.settings);
    const mc = v.app.metadataCache as unknown as { getFileCache(f: TFile): unknown };
    const real = mc.getFileCache.bind(mc);
    let broken = false;
    mc.getFileCache = (f: TFile) => {
      if (broken && f.path === `${P}/Bob.md`) throw new Error("index broken");
      return real(f);
    };
    const t = await loadTable(v.app, v.settings, "person");
    // the unique values and the graph are kept, then the host's index breaks
    expect(await uniqueValues(v.app, v.settings, t)).not.toBeNull();
    await graphIndex(v.app, v.settings);
    broken = true;
    const idx = vaultIndex(v.app, v.settings)!;
    idx.touch(`${P}/Bob.md`);
    expect(vaultIndex(v.app, v.settings)!.hasFailures).toBe(true);
    expect(() => catalogRowFilesOf(v.app, v.settings, [{ full: t.catalog.ref.full, def: t.def }])).toThrow("index broken");
    expect(await uniqueValues(v.app, v.settings, t)).toBeNull();
    await expect(graphIndex(v.app, v.settings)).rejects.toThrow("index broken");
    // what the check reads of the host throws too: it compares what it can
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
    broken = false;
    idx.touch(`${P}/Bob.md`);
    expect(vaultIndex(v.app, v.settings)!.hasFailures).toBe(false);
    // a note the host's index throws for, deleted: no failure left
    broken = true;
    idx.touch(`${P}/Bob.md`);
    expect(vaultIndex(v.app, v.settings)!.hasFailures).toBe(true);
    v.remove(`${P}/Bob.md`);
    expect(vaultIndex(v.app, v.settings)!.hasFailures).toBe(false);
    broken = false;
    v.write(`${P}/Bob.md`, person("Bob"));
    expect((await loadRows(v.app, v.settings, t)).map((r) => r.file.path)).toEqual([`${P}/Ada.md`, `${P}/Bob.md`]);
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("a folder deleted takes its notes; a note deleted and created again goes last in the vault's order", async () => {
    const v = nodeVault({ "Notes/a.md": person("A"), "Notes/b.md": person("B"), "Other/c.md": person("C"), "Other/d.md": person("D") });
    await loadMetastore(v.app, v.settings);
    vaultIndex(v.app, v.settings);
    await v.app.vault.delete(v.app.vault.getAbstractFileByPath("Notes")!, true);
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
    // gone and back before the index reads it again: the vault lists it last
    const text = v.read("Other/c.md");
    v.remove("Other/c.md");
    v.write("Other/c.md", text);
    expect(vaultIndex(v.app, v.settings)!.notesInOrder(() => true).map((n) => n.path)).toEqual(v.app.vault.getMarkdownFiles().map((f) => f.path));
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("a change log that no longer reaches back: every index built on it reads again, and agrees", async () => {
    const v = nodeVault({ [`${P}/Ada.md`]: person("Ada", 'friend: "[[Bob]]"\n'), [`${P}/Bob.md`]: person("Bob") });
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Cy" }, body: "Met Ada.\n", autolink: true });
    await graphNeighbors(v.app, v.settings, { from: { paths: [`${P}/Ada.md`] } });
    const t = await loadTable(v.app, v.settings, "person");
    await uniqueValues(v.app, v.settings, t);
    INDEX_LOG.limit = 4;
    for (let i = 0; i < 12; i++) v.write(`Notes/n${i}.md`, `[[Ada]] ${i}\n`);
    v.write(`${P}/Bob.md`, person("Bob", 'friend: "[[Ada]]"\n'));
    const idx = vaultIndex(v.app, v.settings)!;
    expect(idx.changedSince(0, idx.epoch)).toBeNull();
    expect(idx.filesChangedSince(0, idx.epoch)).toBeNull();
    expect(idx.filesChangedSince(idx.fileCursor + 1, idx.epoch)).toBeNull();
    const ms = (await loadMetastore(v.app, v.settings))!;
    expect([...(await currentStates(v.app, v.settings, ms.model, [], new Set(["main.public.person"]))).get("main.public.person")!.files.keys()].sort()).toEqual([
      `${P}/Ada.md`,
      `${P}/Bob.md`,
      `${P}/Cy.md`,
    ]);
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("a change no event reported: every index tells it", async () => {
    const v = nodeVault({ [`${P}/Ada.md`]: person("Ada", 'friend: "[[Bob]]"\naliases: [Countess]\n'), [`${P}/Bob.md`]: person("Bob") });
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    // every index built: names (autolink), vocabularies, unique values, sorted rows, graph, log states
    await insertRow(v.app, v.settings, { table: "person", values: { name: "Cy", buddy: "Ada" }, body: "Met Ada.\n", autolink: true });
    const t = await loadTable(v.app, v.settings, "person");
    await uniqueValues(v.app, v.settings, t);
    await loadRows(v.app, v.settings, t);
    await graphNeighbors(v.app, v.settings, { from: { paths: [`${P}/Ada.md`] } });
    validationContextFor(v.app, v.settings, `${P}/x.md`).vocabulary!("main.public.person");
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
    // the note changes on disk and in the host's index, without an event
    const path = `${P}/Ada.md`;
    const text = person("Ann", 'friend: "[[Cy]]"\naliases: [Duchess]\n');
    fs.writeFileSync(v.abs(path), text);
    meta(v).get(path)!.cache.frontmatter = { table: "main.public.person", name: "Ann", friend: "[[Cy]]", aliases: ["Duchess"] };
    const f = v.app.vault.getAbstractFileByPath(path) as TFile & { stat: { mtime: number; size: number } };
    f.stat = { ...f.stat, mtime: f.stat.mtime + 1000, size: Buffer.byteLength(text) };
    const diffs = await verifyIndex(v.app, v.settings);
    for (const expected of [
      `${path}: front matter differs from the host's`,
      "autolink names differ from the notes' names",
      'names of main.public.person: ["Ada","Bob","Cy"] instead of ["Ann","Bob","Cy"]',
      "unique values of main.public.person differ from its rows",
      `graph: the edges or the table of ${path} differ`,
      `main.public.person: ${path}`,
    ]) {
      expect(diffs).toContain(expected);
    }
    // a row moved out of the table without an event: the sorted rows tell it too
    meta(v).get(`${P}/Bob.md`)!.cache.frontmatter = { name: "Bob" };
    expect(await verifyIndex(v.app, v.settings)).toContain("sorted rows of main.public.person differ from the rows now");
  });

  it("a row the host still lists whose text no longer parses: the reads report the parser's error, as a full read does", async () => {
    const v = nodeVault({ [`${P}/Ada.md`]: person("Ada"), [`${P}/Bob.md`]: person("Bob", 'friend: "[[Ada]]"\n') });
    await loadMetastore(v.app, v.settings);
    const t = await loadTable(v.app, v.settings, "person");
    expect(await uniqueValues(v.app, v.settings, t)).not.toBeNull();
    await graphNeighbors(v.app, v.settings, { from: { paths: [`${P}/Ada.md`] } });
    // the text breaks; the host's index keeps the front matter it had (no event)
    const broken = "---\ntable: [main.public.person\nname: Ada\n---\n";
    fs.writeFileSync(v.abs(`${P}/Ada.md`), broken);
    const f = v.app.vault.getAbstractFileByPath(`${P}/Ada.md`) as TFile & { stat: { mtime: number; size: number } };
    f.stat = { ...f.stat, mtime: f.stat.mtime + 1000, size: broken.length };
    vaultIndex(v.app, v.settings)!.touch(`${P}/Ada.md`);
    await expect(loadRows(v.app, v.settings, t)).rejects.toThrow(/flow collection|Missing|end/i);
    expect(await uniqueValues(v.app, v.settings, t)).toBeNull(); // read again from the change log: fails
    expect(await uniqueValues(v.app, v.settings, t)).toBeNull(); // built again: fails
    await expect(graphIndex(v.app, v.settings)).rejects.toThrow(); // kept: fails, then built: throws
    await expect(graphIndex(v.app, v.settings)).rejects.toThrow();
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("a table whose definition is broken is no table of the graph; a link written twice in a column is one edge", async () => {
    const v = nodeVault({
      [METASTORE]: withTables(`${PERSON}broken:\n  columns:\n    - { name: x, type: nope }\n`),
      [`${P}/Ada.md`]: person("Ada", 'friends: ["[[Bob]]", "[[Bob]]"]\n'),
      [`${P}/Bob.md`]: person("Bob"),
      "B/x.md": '---\ntable: main.public.broken\nx: "[[Ada]]"\n---\n',
    });
    await loadMetastore(v.app, v.settings);
    const g = await graphIndex(v.app, v.settings);
    expect(g.out.get(`${P}/Ada.md`)).toEqual([{ to: `${P}/Bob.md`, label: "friends" }]);
    expect(g.tableOf.has("B/x.md")).toBe(false);
    expect(g.out.get("B/x.md")).toEqual([{ to: `${P}/Ada.md`, label: "link" }]);
    expect(g.out.get("Nowhere.md")).toBeUndefined();
    expect(vaultIndex(v.app, v.settings)!.rowCount("main.public.nothing")).toBe(0);
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("a note the index never heard of: the check tells it; read again, it goes last; invalidated, the index agrees", async () => {
    const v = nodeVault({ "Notes/a.md": "a\n", "Notes/b.md": "b\n" });
    await loadMetastore(v.app, v.settings);
    const idx = vaultIndex(v.app, v.settings)!;
    fs.writeFileSync(v.abs("Notes/c.md"), "c\n");
    (v.app.vault as unknown as NodeHost["vault"]).scanSync(); // the host reads its folder again, silently
    expect((await verifyIndex(v.app, v.settings)).some((d) => d.startsWith('notes: extra [], missing ["Notes/c.md"]'))).toBe(true);
    idx.touch("Notes/c.md");
    expect(vaultIndex(v.app, v.settings)!.note("Notes/c.md")).toBeDefined();
    idx.invalidate();
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("DATANOTES_INDEX_CHECK: after an operation, a difference is an error in the log and the index reads the vault again", async () => {
    const v = nodeVault({ [`${P}/Ada.md`]: person("Ada") });
    await loadMetastore(v.app, v.settings);
    vaultIndex(v.app, v.settings);
    const logs: { severity: string; body: string; attributes?: Record<string, unknown> }[] = [];
    setTelemetry({ log: (severity, body, attributes) => void logs.push({ severity, body, ...(attributes ? { attributes } : {}) }), flush: async () => {} });
    try {
      meta(v).get(`${P}/Ada.md`)!.cache.frontmatter = { name: "Ada" }; // no event
      expect(await checkIndexAfter(v.app, v.settings, "insert_row")).toEqual([]); // the check is off
      enableIndexCheck(v.app);
      const diffs = await checkIndexAfter(v.app, v.settings, "insert_row");
      expect(diffs).toContain(`${P}/Ada.md: front matter differs from the host's`);
      expect(logs).toEqual([{ severity: "ERROR", body: "datanotes vault index out of step with the vault", attributes: expect.objectContaining({ operation: "insert_row", differences: diffs.length }) }]);
      expect(await checkIndexAfter(v.app, v.settings, "insert_row")).toEqual([]);
    } finally {
      setTelemetry(NOOP_TELEMETRY);
    }
  });

  it("DATANOTES_INDEX_CHECK: links found out of step are resolved again, so the difference is told once; a host without relinkAll tells it again", async () => {
    const v = nodeVault({ "Notes/x.md": "[[y]]\n", "Notes/y.md": "plain\n" });
    await loadMetastore(v.app, v.settings);
    vaultIndex(v.app, v.settings);
    setTelemetry({ log: () => {}, flush: async () => {} });
    try {
      enableIndexCheck(v.app);
      v.app.metadataCache.resolvedLinks["Notes/x.md"] = { "Notes/nowhere.md": 1 }; // out of step, no event
      expect((await checkIndexAfter(v.app, v.settings, "insert_row")).some((d) => d.startsWith("Notes/x.md: resolves"))).toBe(true);
      expect(await checkIndexAfter(v.app, v.settings, "insert_row")).toEqual([]);
      expect(v.app.metadataCache.resolvedLinks["Notes/x.md"]).toEqual({ "Notes/y.md": 1 });
      // a host that cannot resolve again: the same difference at every check
      const mc = v.app.metadataCache as unknown as { relinkAll?: unknown };
      mc.relinkAll = undefined;
      v.app.metadataCache.resolvedLinks["Notes/x.md"] = { "Notes/nowhere.md": 1 };
      expect((await checkIndexAfter(v.app, v.settings, "insert_row")).length).toBeGreaterThan(0);
      expect((await checkIndexAfter(v.app, v.settings, "insert_row")).length).toBeGreaterThan(0);
    } finally {
      setTelemetry(NOOP_TELEMETRY);
    }
  });

  it("the graph's nodes come in a build's order: the rows by table and path, then the other notes", async () => {
    const v = nodeVault({
      [`${P}/Bob.md`]: person("Bob", 'friend: "[[Ada]]"\n'),
      [`${P}/Ada.md`]: person("Ada", 'friend: "[[Bob]]"\n'),
      "Notes/x.md": "[[Ada]] [[Notes/y]]\n",
      "Notes/y.md": "plain\n",
    });
    await loadMetastore(v.app, v.settings);
    const g = await graphIndex(v.app, v.settings);
    expect([...g.out.keys()]).toEqual([`${P}/Ada.md`, `${P}/Bob.md`, "Notes/x.md"]);
    expect([...g.in.keys()]).toEqual([`${P}/Bob.md`, `${P}/Ada.md`, "Notes/y.md"]);
    expect(g.out.has("Notes/y.md")).toBe(false);
    expect(g.in.has(`${P}/Ada.md`)).toBe(true);
    expect(g.in.get(`${P}/Ada.md`)).toEqual([
      { to: `${P}/Bob.md`, label: "friend" },
      { to: "Notes/x.md", label: "link" },
    ]);
  });

  it("names of a vocabulary: rows outside the archive, string names only; none without a loaded metastore", async () => {
    const v = nodeVault({
      [`${P}/Ada.md`]: person("Ada"),
      [`${P}/_archive/Old.md`]: person("Old"),
      [`${P}/Num.md`]: "---\ntable: main.public.person\nname: 42\n---\n",
    });
    const ctx = validationContextFor(v.app, v.settings, `${P}/x.md`);
    expect(ctx.vocabulary!("main.public.person")).toBeNull(); // no metastore loaded yet
    await loadMetastore(v.app, v.settings);
    expect([...ctx.vocabulary!("main.public.person")!]).toEqual(["Ada"]);
    expect(ctx.vocabulary!("main.public.person")).toBe(ctx.vocabulary!("main.public.person")); // kept while the rows stay
  });
});
