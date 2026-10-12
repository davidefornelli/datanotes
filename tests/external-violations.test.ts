/**
 * Hand edits (an editor, git, a sync tool) are checked against the tables' rules as they happen:
 * the change feed's external events carry `violations` (what the edit breaks: the edited row's
 * rules, and those of the rows linking to it), the EXTERNAL_EDIT commit counts them, a WARN line
 * logs them, and check_table lists the rows that are invalid now, for one table or all of them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";
import { addConstraint } from "../src/core/catalog-ops";
import { ChangeFeed, MAX_EVENT_VIOLATIONS, type ChangeEvent } from "../src/core/change-feed";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, logExternalEdits } from "../src/core/engine";
import { describeHistory } from "../src/core/history";
import { invalidateFiles } from "../src/core/file-cache";
import { checkExternalEdits, checkTable, insertRow } from "../src/core/rows";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;
afterEach(() => setTelemetry(NOOP_TELEMETRY));

const P = "Datanotes/main/work/project";
const T = "Datanotes/main/work/task";
const N = "Datanotes/main/work/note";
const ref = (n: string) => `[[${P}/${n}|${n}]]`;
const PARENT_BY_LEVEL = {
  or: [
    { kind: "area", parent: { exists: false } },
    { kind: "project", "parent.kind": "area" },
    { kind: "workstream", "parent.kind": "project" },
  ],
};

/** A project row rewritten by hand (its id kept, as an editor keeps it). */
const projectNote = (name: string, kind: string, parent?: string) => (current: string) =>
  `---\ntable: main.work.project\n${/^id: .*$/m.exec(current)![0]}\nname: ${name}\nkind: ${kind}\n${parent ? `parent: "${ref(parent)}"\n` : ""}---\n`;

/**
 * `project` (self-referencing, CHECK parent_by_level): Home (area) ← Site, Shop (projects) ← Build,
 * Paint (workstreams of Site); `task` links to a project of kind project (ref_where); `note` has no
 * rules but its columns, and a plain link to a project (`about`).
 */
async function vault(history = false): Promise<{ v: DbVault; feed: ChangeFeed }> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome", history }, async () => {});
  await createTable(v.app, v.settings, described({
    schema: "work",
    name: "project",
    options: { filename: "{name}" },
    columns: [
      { name: "name", type: "string", required: true, dense: true },
      { name: "kind", type: "enum", values: ["area", "project", "workstream"], dense: true },
      { name: "parent", type: "link", ref: "self" },
    ],
  }));
  await createTable(v.app, v.settings, described({
    schema: "work",
    name: "task",
    options: { filename: "{title}" },
    columns: [
      { name: "title", type: "string", required: true, dense: true },
      { name: "project", type: "link", ref: "main.work.project", ref_where: { kind: "project" } },
    ],
  }));
  await createTable(v.app, v.settings, described({
    schema: "work",
    name: "note",
    options: { filename: "{title}" },
    columns: [
      { name: "title", type: "string", required: true, dense: true },
      { name: "pages", type: "integer", min: 1 },
      { name: "about", type: "link", ref: "main.work.project" },
    ],
  }));
  for (const [name, kind, parent] of [
    ["Home", "area", null],
    ["Site", "project", "Home"],
    ["Shop", "project", "Home"],
    ["Build", "workstream", "Site"],
    ["Paint", "workstream", "Site"],
  ] as const) {
    const r = await insertRow(v.app, v.settings, { table: "project", values: { name, kind, ...(parent ? { parent: ref(parent) } : {}) } });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  }
  expect((await insertRow(v.app, v.settings, { table: "task", values: { title: "Order paint", project: ref("Shop") } })).ok).toBe(true);
  expect((await insertRow(v.app, v.settings, { table: "note", values: { title: "Ideas", pages: 2, about: ref("Paint") } })).ok).toBe(true);
  expect((await addConstraint(v.app, v.settings, { table: "project", name: "parent_by_level", check: PARENT_BY_LEVEL })).ok).toBe(true);
  const feed = new ChangeFeed(v.app, () => v.settings);
  await feed.start();
  return { v, feed };
}

/** Write (or delete: null) notes by hand and let the feed see them (one batch); returns the new events. */
async function handEdit(v: DbVault, feed: ChangeFeed, notes: Record<string, string | null | ((current: string) => string)>): Promise<ChangeEvent[]> {
  const since = feed.lastSeq;
  for (const [p, text] of Object.entries(notes)) {
    if (text === null) v.remove(p);
    else v.write(p, typeof text === "string" ? text : text(v.read(p)));
    invalidateFiles(v.app, [p]);
    feed.touch(p);
  }
  await feed.flush();
  return (await feed.read({ since })).events;
}

/** Rename a note by hand (the vault's rename event; links to it are not rewritten). */
async function handRename(v: DbVault, feed: ChangeFeed, from: string, to: string): Promise<void> {
  if (!(await v.rename(from, to))) feed.moved(from, to); // the fake App has no events: send it
}

/** Collect the telemetry log lines. */
function logLines(): { body: string; attrs: Record<string, unknown> }[] {
  const logs: { body: string; attrs: Record<string, unknown> }[] = [];
  setTelemetry({ log: (_s, body, attrs = {}) => logs.push({ body, attrs }), flush: async () => {} });
  return logs;
}

const brief = (vs: ChangeEvent["violations"]) => (vs ?? []).map((x) => [x.path, x.code, x.constraint ?? x.column]);

async function topCommit(v: DbVault, table: string) {
  return (await describeHistory(v.app, v.settings, { table, limit: 1 })).history[0]!;
}

describe("hand edits are checked against the tables' rules", () => {
  it("an edit that breaks a CHECK shows in the change feed with the CHECK's name, and in check_table", async () => {
    const { v, feed } = await vault();
    const logs = logLines();
    // a workstream under an area
    const events = await handEdit(v, feed, { [`${P}/Build.md`]: projectNote("Build", "workstream", "Home") });
    expect(events.map((e) => [e.op, e.path, e.source])).toEqual([["update", `${P}/Build.md`, "external"]]);
    // the CHECK's text is in metastore.yaml, not repeated in the message
    expect(events[0]!.violations).toEqual([{ path: `${P}/Build.md`, code: "check", constraint: "parent_by_level", message: "violates CHECK parent_by_level" }]);
    expect(logs.filter((l) => l.body === "datanotes hand edits break table rules").map((l) => l.attrs)).toEqual([
      { edited_rows: 1, violating_rows: 1, violations: 1, tables: "main.work.project" },
    ]);
    // the row stays invalid until fixed: check_table lists it, alone or with every table, the CHECK as `constraint`
    const one = await checkTable(v.app, v.settings, { table: "project" });
    expect(one.violations.map((x) => [x.path, x.violations.map((y) => [y.code, y.constraint, y.column])])).toEqual([[`${P}/Build.md`, [["check", "parent_by_level", undefined]]]]);
    expect(one.total).toBe(1);
    const all = await checkTable(v.app, v.settings, {});
    expect(all).toMatchObject({ table: null, tables_checked: 3, rows_checked: 7, total: 1 });
    expect(all.violations.map((x) => [x.table, x.path])).toEqual([["main.work.project", `${P}/Build.md`]]);
    await feed.stop();
  });

  it("an edit that changes a parent's kind reports the rows linking to it that now break", async () => {
    const { v, feed } = await vault();
    // Site becomes an area: Build and Paint (its workstreams) break the CHECK
    const events = await handEdit(v, feed, { [`${P}/Site.md`]: projectNote("Site", "area") });
    const site = events.find((e) => e.path === `${P}/Site.md`)!;
    expect(brief(site.violations)).toEqual([
      [`${P}/Build.md`, "check", "parent_by_level"],
      [`${P}/Paint.md`, "check", "parent_by_level"],
    ]);
    expect(site.violations![0]!.message).toBe("violates CHECK parent_by_level (after the edit of [[Site]], a row it links to)");
    // Shop becomes an area: the task linking to it breaks its ref_where (code ref, its column)
    const shop = (await handEdit(v, feed, { [`${P}/Shop.md`]: projectNote("Shop", "area") }))[0]!;
    expect(brief(shop.violations)).toEqual([[`${T}/Order paint.md`, "ref", "project"]]);
    await feed.stop();
  });

  it("a valid edit reports no violations; the edited row's own columns are checked too", async () => {
    const { v, feed } = await vault();
    const ok = await handEdit(v, feed, { [`${P}/Paint.md`]: projectNote("Paint", "workstream", "Shop") });
    expect(ok.map((e) => [e.op, e.violations])).toEqual([["update", []]]);
    // a new note with a value out of range and a missing required column
    const bad = await handEdit(v, feed, { [`${N}/Draft.md`]: "---\ntable: main.work.note\npages: 0\n---\n" });
    expect(bad.map((e) => e.op)).toEqual(["insert"]);
    expect(bad[0]!.violations!.map((x) => [x.code, x.column]).sort()).toEqual([
      ["min", "pages"],
      ["required", "title"],
    ]);
    await feed.stop();
  });

  it("tables without history get the feed's violations; with history the EXTERNAL_EDIT commit counts them", async () => {
    const off = await vault();
    expect((await describeHistory(off.v.app, off.v.settings, { table: "project" })).history).toEqual([]);
    const events = await handEdit(off.v, off.feed, { [`${P}/Build.md`]: projectNote("Build", "workstream", "Home") });
    expect(events[0]!.violations).toHaveLength(1);
    await off.feed.stop();

    const on = await vault(true);
    await handEdit(on.v, on.feed, { [`${P}/Site.md`]: projectNote("Site", "area") });
    await logExternalEdits(on.v.app, on.v.settings);
    const top = await topCommit(on.v, "project");
    expect(top.operation).toBe("EXTERNAL_EDIT");
    expect(top.operationMetrics).toEqual({ numAddedFiles: 1, numRemovedFiles: 1, metadataChanged: false, violations: 2 });
    // a valid edit counts none
    await handEdit(on.v, on.feed, { [`${P}/Site.md`]: projectNote("Site", "project", "Home") });
    await logExternalEdits(on.v.app, on.v.settings);
    expect((await topCommit(on.v, "project")).operationMetrics.violations).toBe(0);
    await on.feed.stop();
  });

  it("costs nothing beyond the edited rows when no rule reads their table", async () => {
    const { v, feed } = await vault();
    v.write(`${N}/Ideas.md`, v.read(`${N}/Ideas.md`).replace("pages: 2", "pages: 3"));
    // the project table's CHECK and the task's ref_where read only the project table
    expect(await checkExternalEdits(v.app, v.settings, [`${N}/Ideas.md`])).toEqual({
      byPath: new Map([[`${N}/Ideas.md`, []]]),
      loaded: [],
      tableOf: new Map(),
    });
    // an edit of a project reads the tables whose rules follow links to it, and nothing else
    expect((await checkExternalEdits(v.app, v.settings, [`${P}/Site.md`])).loaded).toEqual(["main.work.project", "main.work.task"]);
    // a path that is not a row is skipped
    expect((await checkExternalEdits(v.app, v.settings, ["Notes/none.md"])).byPath.size).toBe(0);
    await feed.stop();
  });
});

describe("review fixes", () => {
  it("one unreadable note does not lose the batch: it is an unreadable event, the other edits are recorded (1)", async () => {
    const { v, feed } = await vault();
    // like Obsidian, the index has no frontmatter for a note whose YAML it cannot parse
    const cache = v.app.metadataCache as unknown as { getFileCache(f: { path: string }): unknown };
    const real = cache.getFileCache.bind(cache);
    cache.getFileCache = (f) => {
      try {
        return real(f);
      } catch {
        return {};
      }
    };
    const logs = logLines();
    const events = await handEdit(v, feed, {
      [`${P}/Build.md`]: (t) => t.replace("name: Build", "name: [unclosed"),
      [`${P}/Paint.md`]: projectNote("Paint", "workstream", "Home"),
    });
    expect(events.map((e) => [e.op, e.path, e.table])).toEqual([
      ["unreadable", `${P}/Build.md`, "main.work.project"],
      ["update", `${P}/Paint.md`, "main.work.project"],
    ]);
    expect(events[0]!.violations).toEqual([{ path: `${P}/Build.md`, code: "unreadable", message: expect.stringMatching(/^the front matter cannot be read, so the row is left out of every read: /) }]);
    expect(events[0]!.id).toBeDefined(); // the row the feed knew
    expect(brief(events[1]!.violations)).toEqual([[`${P}/Paint.md`, "check", "parent_by_level"]]);
    expect(logs.filter((l) => l.body === "datanotes change feed could not read a hand-edited note")).toEqual([]);
    expect(logs.filter((l) => l.body === "datanotes hand edit left a row unreadable").map((l) => [l.attrs.path, l.attrs.table])).toEqual([[`${P}/Build.md`, "main.work.project"]]);
    // Paint's new state was kept: fixing it is one update, back to valid
    const fixed = await handEdit(v, feed, { [`${P}/Paint.md`]: projectNote("Paint", "workstream", "Site") });
    expect(fixed.map((e) => [e.op, e.changes?.parent, e.violations])).toEqual([["update", { before: ref("Home"), after: ref("Site") }, []]]);
    // Build's last readable state was kept: its fix is an update of it
    const back = await handEdit(v, feed, { [`${P}/Build.md`]: (t) => t.replace("name: [unclosed", "name: Built") });
    expect(back.map((e) => [e.op, e.changes?.name])).toEqual([["update", { before: "Build", after: "Built" }]]);
    // a broken note at start is skipped too
    const again = new ChangeFeed(v.app, () => v.settings);
    await again.start();
    await again.stop();
    await feed.stop();
  });

  it("deleting a row, or removing its table, reports the rows linking to it on the delete event (2)", async () => {
    const { v, feed } = await vault(true);
    await logExternalEdits(v.app, v.settings);
    // Shop deleted: the task's filtered link points to no row
    const del = await handEdit(v, feed, { [`${P}/Shop.md`]: null });
    expect(del.map((e) => [e.op, e.path])).toEqual([["delete", `${P}/Shop.md`]]);
    expect(brief(del[0]!.violations)).toEqual([[`${T}/Order paint.md`, "broken_link", "project"]]);
    expect(del[0]!.violations![0]!.message).toMatch(/^\[\[Shop\]\] is not a row of main\.work\.project; .* \(after the removal of \[\[Shop\]\], a row it links to\)$/);
    // the remove-only commit counts what it broke in its own table (the task is another table: 0 here)
    await logExternalEdits(v.app, v.settings);
    expect((await topCommit(v, "project")).operationMetrics).toEqual({ numAddedFiles: 0, numRemovedFiles: 1, metadataChanged: false, violations: 0 });
    // Paint loses its `table`: the note's plain link and nothing else (Paint has no children)
    const left = await handEdit(v, feed, { [`${P}/Paint.md`]: (t) => t.replace("table: main.work.project\n", "") });
    expect(left.map((e) => [e.op, e.path])).toEqual([["delete", `${P}/Paint.md`]]);
    expect(brief(left[0]!.violations)).toEqual([[`${N}/Ideas.md`, "ref", "about"]]);
    // Site deleted: its workstreams break the CHECK and their plain `parent` link; the commit counts them
    const site = await handEdit(v, feed, { [`${P}/Site.md`]: null });
    expect(brief(site[0]!.violations)).toEqual([
      [`${P}/Build.md`, "check", "parent_by_level"],
      [`${P}/Build.md`, "broken_link", "parent"],
    ]);
    // one commit for both removals (Paint, Site): the project rows they break, not the note's link to Paint
    await logExternalEdits(v.app, v.settings);
    expect((await topCommit(v, "project")).operationMetrics).toEqual({ numAddedFiles: 0, numRemovedFiles: 2, metadataChanged: false, violations: 2 });
    await feed.stop();
  });

  it("a rename by hand (vault rename, or delete + create) reports the rows whose links now dangle (3)", async () => {
    const { v, feed } = await vault();
    // links left as they were (by default the engine repairs them first: hand-moves.test.ts)
    v.settings.repairLinksOnHandMove = false;
    const since = feed.lastSeq;
    await handRename(v, feed, `${P}/Shop.md`, `${P}/Shop 2.md`);
    await feed.flush();
    const moved = (await feed.read({ since })).events;
    expect(moved.map((e) => [e.op, e.path, e.oldPath])).toEqual([["move", `${P}/Shop 2.md`, `${P}/Shop.md`]]);
    expect(brief(moved[0]!.violations)).toEqual([[`${T}/Order paint.md`, "broken_link", "project"]]);
    expect(moved[0]!.violations![0]!.message).toContain("(after the rename of [[Shop]], a row it links to)");
    // git-style: Site deleted and created under another name, same id
    const site = v.read(`${P}/Site.md`);
    const events = await handEdit(v, feed, { [`${P}/Site.md`]: null, [`${P}/Site 2.md`]: site });
    // the delete comes first (as the headless host's watcher reports a rename): still one move
    expect(events.map((e) => [e.op, e.path, e.oldPath])).toEqual([["move", `${P}/Site 2.md`, `${P}/Site.md`]]);
    const reported = events.flatMap((e) => brief(e.violations)).sort();
    expect(reported).toEqual([
      [`${P}/Build.md`, "broken_link", "parent"],
      [`${P}/Build.md`, "check", "parent_by_level"],
      [`${P}/Paint.md`, "broken_link", "parent"],
      [`${P}/Paint.md`, "check", "parent_by_level"],
    ]);
    await feed.stop();
  });

  it("a hand edit of metastore.yaml checks the tables it changes, on the schema event and the commit (4)", async () => {
    const { v, feed } = await vault(true);
    await logExternalEdits(v.app, v.settings);
    const logs = logLines();
    // the task may now link only to areas: Order paint (on Shop, a project) breaks it
    const events = await handEdit(v, feed, { [METASTORE]: (t) => t.replace(/(ref_where:\n {18}kind:) project/, "$1 area") });
    expect(events.map((e) => e.op)).toEqual(["schema"]);
    expect(brief(events[0]!.violations)).toEqual([[`${T}/Order paint.md`, "ref", "project"]]);
    expect(logs.filter((l) => l.body === "datanotes hand edit of metastore.yaml breaks table rules").map((l) => l.attrs)).toEqual([
      { tables: "main.work.task", violating_rows: 1, violations: 1 },
    ]);
    await logExternalEdits(v.app, v.settings);
    expect((await topCommit(v, "task")).operationMetrics).toEqual({ numAddedFiles: 0, numRemovedFiles: 0, metadataChanged: true, violations: 1 });
    // a change that leaves every table's entry as it was checks nothing: no violations
    const comment = await handEdit(v, feed, { [METASTORE]: (t) => `# edited by hand\n${t}` });
    expect(comment.map((e) => [e.op, "violations" in e])).toEqual([["schema", false]]);
    await feed.stop();
  });

  it("renames are batched with the other hand edits, in order, checked once (5)", async () => {
    const { v, feed } = await vault();
    const logs = logLines();
    const since = feed.lastSeq;
    v.write(`${P}/Build.md`, projectNote("Build", "workstream", "Home")(v.read(`${P}/Build.md`)));
    feed.touch(`${P}/Build.md`);
    await handRename(v, feed, `${P}/Shop.md`, `${P}/Shop 2.md`);
    await handRename(v, feed, `${P}/Home.md`, `Archive/Home.md`);
    await feed.flush();
    const events = (await feed.read({ since })).events;
    expect(events.filter((e) => e.source === "external").map((e) => [e.op, e.path])).toEqual([
      ["update", `${P}/Build.md`],
      ["move", `${P}/Shop 2.md`],
      ["move", "Archive/Home.md"],
    ]);
    // one check for the batch: one WARN line for the three edits
    expect(logs.filter((l) => l.body === "datanotes hand edits break table rules").map((l) => l.attrs.edited_rows)).toEqual([3]);
    await feed.stop();
  });

  it("a sync of the log checks the hand edits of every table once, and not right before an engine write (6)", async () => {
    const { v, feed } = await vault(true);
    await logExternalEdits(v.app, v.settings);
    // Site becomes an area (its workstreams break) and the task moves to Home (an area: it breaks)
    await handEdit(v, feed, {
      [`${P}/Site.md`]: projectNote("Site", "area"),
      [`${T}/Order paint.md`]: (t) => t.replace(ref("Shop"), ref("Home")),
    });
    await logExternalEdits(v.app, v.settings);
    // counts split per table: each counts its own rows
    expect((await topCommit(v, "project")).operationMetrics.violations).toBe(2);
    expect((await topCommit(v, "task")).operationMetrics.violations).toBe(1);
    // hand edits logged right before an engine write are not checked there (no count)
    await handEdit(v, feed, { [`${P}/Shop.md`]: projectNote("Shop", "area") });
    expect((await insertRow(v.app, v.settings, { table: "note", values: { title: "Later" } })).ok).toBe(true);
    const history = (await describeHistory(v.app, v.settings, { table: "project", limit: 2 })).history;
    expect(history.map((h) => [h.operation, h.operationMetrics.violations])).toEqual([["EXTERNAL_EDIT", undefined], ["EXTERNAL_EDIT", 2]]);
    await feed.stop();
  });

  it("only what the edit breaks is reported: rules a row already broke are not blamed on it (7)", async () => {
    const { v, feed } = await vault();
    // Build becomes invalid by hand (reported) ...
    expect((await handEdit(v, feed, { [`${P}/Build.md`]: projectNote("Build", "workstream", "Home") }))[0]!.violations).toHaveLength(1);
    // ... then edited again, still invalid: nothing new
    const again = await handEdit(v, feed, { [`${P}/Build.md`]: (t) => t.replace("kind: workstream", "kind: workstream\npages: 3") });
    expect(again.map((e) => [e.op, e.violations])).toEqual([["update", [{ path: `${P}/Build.md`, code: "unknown_column", column: "pages", message: expect.any(String) }]]]);
    // an edit of the row it links to does not blame it either
    const home = await handEdit(v, feed, { [`${P}/Home.md`]: (t) => t.replace("name: Home", "name: Home base") });
    expect(home.map((e) => e.violations)).toEqual([[]]);
    await feed.stop();
  });

  it("a commit counts only its table's rows, and only edits whose frontmatter changed (8)", async () => {
    const { v, feed } = await vault(true);
    await handEdit(v, feed, { [`${P}/Build.md`]: projectNote("Build", "workstream", "Home") });
    await logExternalEdits(v.app, v.settings);
    expect((await topCommit(v, "project")).operationMetrics.violations).toBe(1);
    // a body-only edit of the invalid row: nothing checked, no count
    await handEdit(v, feed, { [`${P}/Build.md`]: (t) => `${t}\nSome notes.\n` });
    await logExternalEdits(v.app, v.settings);
    const body = await topCommit(v, "project");
    expect(body.operationMetrics).toEqual({ numAddedFiles: 1, numRemovedFiles: 1, metadataChanged: false });
    // Shop becomes an area: it breaks the task (another table): the feed reports it, the project's commit does not count it
    const shop = await handEdit(v, feed, { [`${P}/Shop.md`]: projectNote("Shop", "area") });
    expect(brief(shop[0]!.violations)).toEqual([[`${T}/Order paint.md`, "ref", "project"]]);
    await logExternalEdits(v.app, v.settings);
    expect((await topCommit(v, "project")).operationMetrics.violations).toBe(0);
    await feed.stop();
  });

  it("unique and hierarchy checks see edited rows the host has not indexed yet (9)", async () => {
    const { v, feed } = await vault();
    v.write(METASTORE, v.read(METASTORE).replace(/(dense: true\n)( {14}- name: pages)/, "$1                unique: true\n$2"));
    expect(v.read(METASTORE)).toMatch(/unique: true\n {14}- name: pages/);
    const draft = `${N}/Copy.md`;
    v.write(draft, "---\ntable: main.work.note\ntitle: Ideas\n---\n");
    // the host's index does not know the new note yet
    const cache = v.app.metadataCache as unknown as { getFileCache(f: { path: string }): unknown };
    const real = cache.getFileCache.bind(cache);
    cache.getFileCache = (f) => (f.path === draft ? {} : real(f));
    const r = await checkExternalEdits(v.app, v.settings, [{ path: draft, before: null }]);
    expect(brief(r.byPath.get(draft))).toEqual([[draft, "unique", "title"]]);
    await feed.stop();
  });

  it("notes in a table's exclude folders are not rows: no event, nothing reported (10)", async () => {
    const { v, feed } = await vault();
    v.write(METASTORE, v.read(METASTORE).replace(/(\n {10}note:\n(?: {12}description: .*\n)? {12}options:\n)/, "$1              exclude: [Templates]\n"));
    expect(v.read(METASTORE)).toContain("exclude: [Templates]");
    const events = await handEdit(v, feed, { [METASTORE]: (t) => t, "Templates/note.md": "---\ntable: main.work.note\npages: 0\n---\n" });
    expect(events.filter((e) => e.op !== "schema")).toEqual([]);
    expect((await checkExternalEdits(v.app, v.settings, ["Templates/note.md"])).byPath.size).toBe(0);
    await feed.stop();
  });

  it("stop records the hand edits seen so far, and nothing after (11)", async () => {
    const { v, feed } = await vault();
    const since = feed.lastSeq;
    v.write(`${P}/Build.md`, projectNote("Build", "workstream", "Home")(v.read(`${P}/Build.md`)));
    feed.touch(`${P}/Build.md`);
    await feed.stop(); // no flush: the pending edit is compared by stop
    const events = (await feed.read({ since })).events;
    expect(events.map((e) => [e.op, e.path, e.violations?.length])).toEqual([["update", `${P}/Build.md`, 1]]);
    v.write(`${P}/Paint.md`, projectNote("Paint", "workstream", "Home")(v.read(`${P}/Paint.md`)));
    feed.touch(`${P}/Paint.md`);
    await feed.flush();
    expect(feed.lastSeq).toBe(events[0]!.seq);
  });

  it("check_table pages its rows, reports a table it cannot check, and events cap their violations (12)", async () => {
    const { v, feed } = await vault();
    for (const n of ["Build", "Paint"]) await handEdit(v, feed, { [`${P}/${n}.md`]: projectNote(n, "workstream", "Home") });
    const page = await checkTable(v.app, v.settings, { table: "project", limit: 1, offset: 1 });
    expect([page.total, page.violations.map((x) => x.path)]).toEqual([2, [`${P}/Paint.md`]]);
    // a table whose definition cannot be read: listed in errors, the others still checked
    v.write(METASTORE, v.read(METASTORE).replace(/(\n {10}note:\n(?: {12}description: .*\n)? {12}options:\n)/, "$1              exclude: 3\n"));
    const all = await checkTable(v.app, v.settings, {});
    expect(all.errors).toEqual([{ table: "main.work.note", error: expect.stringMatching(/folder or a list of folders/) }]);
    expect([all.tables_checked, all.total]).toEqual([2, 2]);
    await feed.stop();

    // a hand edit breaking more than MAX_EVENT_VIOLATIONS rules: the event lists the first ones and counts them all
    const w = await vault();
    const notes: Record<string, string> = {};
    for (let i = 0; i <= MAX_EVENT_VIOLATIONS; i++) notes[`${N}/n${i}.md`] = `---\ntable: main.work.note\ntitle: n${i}\nabout: "${ref("Shop")}"\n---\n`;
    await handEdit(w.v, w.feed, notes);
    const [ev] = await handEdit(w.v, w.feed, { [`${P}/Shop.md`]: null });
    // the notes' links, and the task's
    expect([ev!.violations!.length, ev!.violationsTotal]).toEqual([MAX_EVENT_VIOLATIONS, MAX_EVENT_VIOLATIONS + 2]);
    await w.feed.stop();
  });

  it("the API describes what is produced: `constraint` in check_table, no inverse / generated codes for hand edits (13)", () => {
    const op = (name: string) => OPERATIONS.find((o) => o.name === name)!;
    const json = (name: string) => JSON.stringify(op(name).responseSchema);
    type Codes = { properties: { violations: { items: { properties: { code: { enum: string[] } } } } } };
    const events = (op("list_changes").responseSchema as { properties: { events: { items: { properties: Record<string, { description?: string; items?: Codes }> } } } }).properties.events.items.properties;
    // grouped by row, as a write's answer lists them
    const codes = events.violations!.items!.properties.violations.items.properties.code.enum;
    expect(codes).not.toContain("inverse");
    expect(codes).not.toContain("generated");
    expect(events.violations!.description).toMatch(/absent when nothing was checked/i);
    expect(events.violations_total).toBeDefined();
    expect(json("check_table")).toContain('"constraint"');
    expect(op("check_table").description).toContain("`constraint`");
    expect(JSON.stringify(op("check_table").inputSchema)).toContain('"offset"');
  });
});
