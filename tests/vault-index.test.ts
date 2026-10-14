/**
 * The vault index (src/core/vault-index.ts) against a walk over the vault: after random sequences
 * of engine writes, hand edits, hand deletes, renames (in case only too), folder moves, schema
 * changes (aliases, exclude folders, a table renamed) and a change of the table key, the index
 * answers exactly what a walk over every note answers (`verifyIndex`), on the headless host.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { verifyIndex } from "../src/core/index-check";
import { graphNeighbors } from "../src/core/graph";
import { catalogRowFilesOf, scanRowFilesOf } from "../src/core/row-files";
import { alterTable, deleteRows, insertRow, updateRow } from "../src/core/rows";
import { vaultIndex } from "../src/core/vault-index";
import { loadMetastore } from "../src/core/metastore";
import { configureDatabase } from "../src/core/database";
import { forgetCurrentStates, readCurrentStates, syncTransactionLogs, verifyCurrentStates } from "../src/core/transaction-log";
import type { NodeHost } from "../src/node/node-app";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const PERSON = `person:
  options:
    filename: "{name}"
    archive: _archive
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: name, type: string, required: true, unique: true }
    - { name: buddy, type: string, vocabulary: main.public.person }
`;

const opened: DbVault[] = [];
afterEach(() => {
  for (const v of opened.splice(0)) (v.app as unknown as { metadataCache: NodeHost["metadataCache"] }).metadataCache.dispose?.();
});

function nodeVault(files: Record<string, string> = {}): DbVault {
  const v = createDbVault({ [METASTORE]: withTables(PERSON), ...files }, {}, { host: "node" });
  opened.push(v);
  return v;
}

function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLE_VALUES = ["main.public.log", "main.public.person", "log", "person", "people", "nothing", "", null, 7];
const FOLDERS = ["Daily", "Notes", "Templates", "Datanotes/main/public/person", "Datanotes/main/public/person/_archive"];

/** A note's text: a row of some table (or a value naming none), a plain note, or broken YAML. */
function noteText(rnd: () => number, i: number): string {
  const r = rnd();
  if (r < 0.1) return `Plain note ${i}\n`;
  if (r < 0.15) return `---\ntable: [broken\n---\nBroken ${i}\n`;
  const v = TABLE_VALUES[Math.floor(rnd() * TABLE_VALUES.length)];
  const id = `01a0f000-0000-7000-8000-${String(100000000000 + i).slice(-12)}`;
  // links in a link column (`people`), to notes that may come and go
  const people = [0, 1, 2].filter(() => rnd() < 0.5).map(() => `"[[${rnd() < 0.5 ? `Person ${Math.floor(rnd() * 30)}` : `hand ${Math.floor(rnd() * 30)}`}]]"`);
  return `---\ntable: ${JSON.stringify(v)}\nid: ${id}\nname: Hand ${i}\nkind: mood\noccurred_at: 2026-09-25T22:30\npeople: [${people.join(", ")}]\n---\nBody ${i} [[Person ${Math.floor(rnd() * 30)}]]\n`;
}

describe("vault index", () => {
  it("lists a table's rows in the vault's order, without its archive and exclude folders", async () => {
    const v = nodeVault({
      "Daily/a.md": "---\ntable: main.public.log\nkind: mood\n---\n",
      "Templates/t.md": "---\ntable: log\nkind: mood\n---\n",
      "Datanotes/main/public/log/_archive/old.md": "---\ntable: main.public.log\nkind: mood\n---\n",
      "Daily/b.md": "---\ntable: person\nname: B\n---\n",
    });
    await loadMetastore(v.app, v.settings);
    const defs = [
      { full: "main.public.log", def: { options: { exclude: ["Templates"] }, layout: { archive: "Datanotes/main/public/log/_archive" } } },
      { full: "main.public.person", def: { options: {}, layout: { archive: "Datanotes/main/public/person/_archive" } } },
    ] as never;
    const paths = (m: Map<string, { path: string }[]>) => [...m].map(([t, fs]) => [t, fs.map((f) => f.path)]);
    expect(paths(catalogRowFilesOf(v.app, v.settings, defs))).toEqual(paths(scanRowFilesOf(v.app, v.settings, defs)));
    expect(paths(catalogRowFilesOf(v.app, v.settings, defs))).toEqual([
      ["main.public.log", ["Daily/a.md"]],
      ["main.public.person", ["Daily/b.md"]],
    ]);
    const idx = vaultIndex(v.app, v.settings)!;
    expect(idx.rowCount("main.public.log")).toBe(3);
    expect(idx.tables().sort()).toEqual(["main.public.log", "main.public.person"]);
    // the change log: what changed since a cursor, and a rebuild when it no longer reaches back
    const at = idx.cursor;
    v.write("Daily/c.md", "---\ntable: log\n---\n");
    vaultIndex(v.app, v.settings);
    expect([...idx.changedSince(at, idx.epoch)!]).toEqual(["Daily/c.md"]);
    expect(idx.changedSince(at, idx.epoch + 1)).toBeNull();
    expect(idx.changedSince(at + 100, idx.epoch)).toBeNull();
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("has no index on a host without events (the fake App): the walk answers", async () => {
    const v = createDbVault({ [METASTORE]: withTables(PERSON) }, {}, { host: "fake" });
    expect(vaultIndex(v.app, v.settings)).toBeNull();
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("reports a note it missed, and reads the vault again once invalidated", async () => {
    const v = nodeVault({ "Daily/a.md": "---\ntable: log\n---\n" });
    await loadMetastore(v.app, v.settings);
    const idx = vaultIndex(v.app, v.settings)!;
    // the host changes a note's front matter without telling (no event): the index does not know
    const mc = v.app.metadataCache as unknown as { meta: Map<string, { cache: { frontmatter?: Record<string, unknown> } }> };
    mc.meta.get("Daily/a.md")!.cache.frontmatter = { table: "person" };
    const diffs = await verifyIndex(v.app, v.settings);
    expect(diffs).toContain("Daily/a.md: front matter differs from the host's");
    expect(diffs).toContain('Daily/a.md: a row of "main.public.log" instead of "main.public.person"');
    expect(diffs.some((d) => d.startsWith("rows of main.public.log: extra"))).toBe(true);
    idx.invalidate();
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  it("the transaction log's states kept between syncs: a change no event reported is found by the check, and logged once repaired", async () => {
    const v = nodeVault({ "Daily/a.md": "---\ntable: main.public.log\nkind: mood\noccurred_at: 2026-09-25T22:30\n---\nA\n" });
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    await insertRow(v.app, v.settings, { table: "log", values: { kind: "walk", occurred_at: "2026-09-26T08:00" } });
    expect(await verifyCurrentStates(v.app, v.settings)).toEqual([]);
    // the note changes on disk, and the host's index learns it without telling anyone (no event)
    const text = v.read("Daily/a.md").replace("kind: mood", "kind: walk");
    const fs = await import("node:fs");
    fs.writeFileSync(v.abs("Daily/a.md"), text);
    const f = v.app.vault.getAbstractFileByPath("Daily/a.md") as { stat: { mtime: number; size: number } };
    f.stat = { ...f.stat, mtime: f.stat.mtime + 1000, size: text.length };
    expect(await syncTransactionLogs(v.app, v.settings, { operation: "EXTERNAL_EDIT" })).toEqual([]); // missed
    expect(await verifyCurrentStates(v.app, v.settings, true)).toEqual(["main.public.log: Daily/a.md"]);
    const commits = await syncTransactionLogs(v.app, v.settings, { operation: "EXTERNAL_EDIT" });
    expect(commits.map((c) => [c.table, c.operation])).toEqual([["main.public.log", "EXTERNAL_EDIT"]]);
    expect(await verifyCurrentStates(v.app, v.settings)).toEqual([]);
    // a path an operation names, which the host's index does not list as a row yet (its index
    // lags, as Obsidian's does right after a write), is read from its text; once no operation
    // names it, it is no row of the log until the index lists it
    v.write("Daily/b.md", "---\ntable: main.public.log\nkind: mood\noccurred_at: 2026-09-27T08:00\n---\n");
    const mc = v.app.metadataCache as unknown as { meta: Map<string, { cache: { frontmatter?: Record<string, unknown> } }> };
    const listed = mc.meta.get("Daily/b.md")!.cache.frontmatter;
    mc.meta.get("Daily/b.md")!.cache.frontmatter = undefined;
    vaultIndex(v.app, v.settings)!.touch("Daily/b.md");
    const ms = (await loadMetastore(v.app, v.settings))!;
    const named = await syncTransactionLogs(v.app, v.settings, { operation: "WRITE", touched: ["Daily/b.md"] });
    expect(named.map((c) => c.table)).toEqual(["main.public.log"]);
    expect([...(await readCurrentStates(v.app, v.settings, ms.model, ["Daily/b.md"])).get("main.public.log")!.files.keys()]).toContain("Daily/b.md");
    const unnamed = await syncTransactionLogs(v.app, v.settings, { operation: "EXTERNAL_EDIT" });
    expect(unnamed.map((c) => c.table)).toEqual(["main.public.log"]); // no row of the log any more
    expect(await verifyCurrentStates(v.app, v.settings)).toEqual([]);
    mc.meta.get("Daily/b.md")!.cache.frontmatter = listed;
    vaultIndex(v.app, v.settings)!.touch("Daily/b.md");
    forgetCurrentStates(v.app);
    expect(await verifyCurrentStates(v.app, v.settings)).toEqual([]);
  });

  it("the link graph follows a file that a link column names as it comes, goes and moves", async () => {
    const v = nodeVault({
      "Daily/a.md": '---\ntable: main.public.log\nkind: mood\noccurred_at: 2026-09-25T22:30\npeople: ["[[Ghost]]", "[[Paul]]"]\n---\nSee [[Ghost]].\n',
      "People/Paul.md": "Paul\n",
    });
    await loadMetastore(v.app, v.settings);
    const edges = async (p: string) => {
      const r = await graphNeighbors(v.app, v.settings, { from: { paths: [p] }, direction: "both" });
      return r.nodes[0]!.edges.map((e) => `${e.direction}:${e.label}:${e.path}`);
    };
    expect(await edges("Daily/a.md")).toEqual(["out:people:People/Paul.md"]);
    v.write("People/Ghost.md", "Boo\n");
    expect(await edges("Daily/a.md")).toEqual(["out:people:People/Ghost.md", "out:people:People/Paul.md"]);
    expect(await edges("People/Ghost.md")).toEqual(["in:people:Daily/a.md"]);
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
    await v.rename("People/Ghost.md", "Other/Ghost.md");
    expect(await edges("Daily/a.md")).toEqual(["out:people:Other/Ghost.md", "out:people:People/Paul.md"]);
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
    v.remove("Other/Ghost.md");
    expect(await edges("Daily/a.md")).toEqual(["out:people:People/Paul.md"]);
    // a plain note's links and a row's other links are `link` edges, in the host's order of the notes
    v.write("Notes/x.md", "[[Paul]]\n");
    v.write("Notes/y.md", "[[Paul]] [[a]]\n");
    expect(await edges("People/Paul.md")).toEqual(["in:people:Daily/a.md", "in:link:Notes/x.md", "in:link:Notes/y.md"]);
    expect(await verifyIndex(v.app, v.settings)).toEqual([]);
  });

  for (const seed of [11, 12, 13, 14, 15, 16]) {
    it(`agrees with a walk over the vault after random writes, hand edits, moves and schema changes (seed ${seed})`, async () => {
      const rnd = random(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const v = nodeVault({ "Daily/a.md": "---\ntable: main.public.log\nkind: mood\noccurred_at: 2026-09-25T22:30\n---\nA\n" });
      const host = v.app.vault as unknown as NodeHost["vault"];
      // history on: every write syncs the transaction log from the current states kept between syncs
      await configureDatabase(v.app, v.settings, { history: true }, async () => {});
      await loadMetastore(v.app, v.settings);
      vaultIndex(v.app, v.settings);
      let personTable = "person";
      let aliases = false;
      let excluded = false;
      for (let step = 0; step < 90; step++) {
        const notes = v.app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => p !== METASTORE);
        const op = rnd();
        try {
        if (op < 0.15) {
          await insertRow(v.app, v.settings, { table: "log", values: { kind: pick(["mood", "walk"]), occurred_at: `2026-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}T08:00` } });
        } else if (op < 0.25) {
          // a name from the table's own rows (vocabulary), and a body that mentions notes (autolink)
          const known = v.app.vault.getMarkdownFiles().filter((f) => f.path.includes(`/${personTable}/`) && !f.path.includes("_archive"));
          const buddy = known.length > 0 && rnd() < 0.5 ? (v.app.metadataCache.getFileCache(pick(known))?.frontmatter?.name as string | undefined) : undefined;
          // now and then a name taken already, in another case and with spaces (a unique violation)
          const taken = known.length > 0 && rnd() < 0.2 ? (v.app.metadataCache.getFileCache(pick(known))?.frontmatter?.name as string | undefined) : undefined;
          const name = typeof taken === "string" ? `${taken.toLowerCase()}  ` : `Person ${step}`;
          const r = await insertRow(v.app, v.settings, {
            table: personTable,
            values: { name, ...(typeof buddy === "string" ? { buddy } : {}) },
            body: `Met ${known.length > 0 ? pick(known).basename : "nobody"} and hand ${step - 1} today.\n`,
            autolink: true,
          });
          // a name taken by a row of the table is refused (unique), whatever else the row breaks
          const ofTable = typeof taken === "string" && known.some((f) => v.app.metadataCache.getFileCache(f)?.frontmatter?.name === taken && vaultIndex(v.app, v.settings)!.note(f.path)?.table === `main.public.${personTable}`);
          if (ofTable) expect(r.conflicts.length > 0 || r.violations.some((x) => x.violations.some((y) => y.code === "unique")), JSON.stringify(r)).toBe(true);
        } else if (op < 0.32) {
          const rows = v.app.vault.getMarkdownFiles().filter((f) => f.path.includes(`/${personTable}/`) && !f.path.includes("_archive"));
          if (rows.length > 0) await updateRow(v.app, v.settings, { table: personTable, path: pick(rows).path, set: { name: `Renamed ${step}` } });
        } else if (op < 0.38) {
          const rows = v.app.vault.getMarkdownFiles().filter((f) => f.path.includes(`/${personTable}/`) && !f.path.includes("_archive"));
          if (rows.length > 0) await deleteRows(v.app, v.settings, { table: personTable, where: { path: pick(rows).path }, mode: rnd() < 0.5 ? "archive" : "delete", onReferenced: "ignore" });
        } else if (op < 0.55) {
          // a hand edit: a new note or a changed one, anywhere
          const p = rnd() < 0.5 && notes.length > 0 ? pick(notes) : `${pick(FOLDERS)}/hand ${step}.md`;
          v.write(p, noteText(rnd, step));
        } else if (op < 0.62) {
          if (notes.length > 0) v.remove(pick(notes));
        } else if (op < 0.74) {
          if (notes.length > 0) {
            const from = pick(notes);
            const caseOnly = rnd() < 0.3;
            const to = caseOnly ? from.replace(/[^/]+$/, (n) => n.toUpperCase()) : `${pick(FOLDERS)}/moved ${step}.md`;
            if (to !== from && (caseOnly || !v.exists(to))) await v.rename(from, to);
          }
        } else if (op < 0.78) {
          // a folder moved by hand, with its notes
          const folder = v.app.vault.getAbstractFileByPath("Notes");
          if (folder && !v.exists("Moved notes")) await host.move(folder, "Moved notes");
          else if (v.app.vault.getAbstractFileByPath("Moved notes") && !v.exists("Notes")) await host.move(v.app.vault.getAbstractFileByPath("Moved notes")!, "Notes");
        } else if (op < 0.84) {
          aliases = !aliases;
          await alterTable(v.app, v.settings, { table: personTable, aliases: aliases ? ["people"] : null });
        } else if (op < 0.9) {
          excluded = !excluded;
          await alterTable(v.app, v.settings, { table: personTable, exclude: excluded ? ["Templates"] : null });
        } else if (op < 0.94) {
          const next = personTable === "person" ? "contact" : "person";
          const r = await alterTable(v.app, v.settings, { table: personTable, name: next });
          if (r.ok) personTable = next;
        } else if (op < 0.97) {
          // another table key: every note is read again
          v.settings.tableKey = v.settings.tableKey === "table" ? "kind" : "table";
          expect(await verifyIndex(v.app, v.settings), `step ${step} (table key ${v.settings.tableKey})`).toEqual([]);
          v.settings.tableKey = "table";
        } else {
          await createTable(v.app, v.settings, described({ name: `extra${step}`, options: { filename: "{title}" }, columns: [{ name: "title", type: "string" }] }));
        }
        } catch (e) {
          // a refusal of the engine (a note in the table folder that is not one of its rows): nothing written
          if (!(e instanceof OperationInputError)) throw e;
        }
        // the link graph is kept up to date from here on (verifyIndex compares it with a full build)
        if (step % 7 === 3 && v.app.vault.getMarkdownFiles().length > 0) await graphNeighbors(v.app, v.settings, { from: { paths: [pick(v.app.vault.getMarkdownFiles()).path] }, direction: "both" });
        expect(await verifyIndex(v.app, v.settings), `step ${step}`).toEqual([]);
      }
    }, 60_000);
  }
});
