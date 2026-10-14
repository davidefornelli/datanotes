import { beforeAll, describe, expect, it } from "vitest";
import { addConstraint } from "../src/core/catalog-ops";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, loadTable, OperationInputError, type LoadedRow } from "../src/core/engine";
import type { TFile } from "../src/core/host";
import { insertRow, select } from "../src/core/rows";
import { rowGetter } from "../src/core/where";
import { createDbVault, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

/** Matches an error of the same class with the same message (toThrow alone compares messages only). */
const exactly = (e: Error) => expect.objectContaining({ constructor: e.constructor, message: e.message });

const A = "Datanotes/main/work/area";
const area = (code: string) => `[[${A}/${code}|${code}]]`;

/**
 * Areas named by a code, titled (A1 Home ← A2 Garden, A3 Kitchen; A4 Work; A5 Spare), people
 * (no hierarchy) and tasks linking to them.
 */
async function work(): Promise<DbVault> {
  const v = createDbVault({});
  await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
  await createTable(v.app, v.settings, described({
    schema: "work", name: "area", options: { filename: "{code}" },
    columns: [{ name: "code", type: "string", required: true }, { name: "title", type: "string" }, { name: "parent", type: "link", ref: "self", hierarchy: true }],
  }));
  await createTable(v.app, v.settings, described({ schema: "work", name: "person", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true }] }));
  await createTable(v.app, v.settings, described({
    schema: "work", name: "task", options: { filename: "{title}" },
    columns: [
      { name: "title", type: "string", required: true },
      { name: "status", type: "enum", values: ["open", "done"] },
      { name: "area", type: "link", ref: "main.work.area" },
      { name: "areas", type: "list", items: "link", ref: "main.work.area" },
      { name: "owner", type: "link", ref: "main.work.person" },
      { name: "labels", type: "list", items: "string" },
    ],
  }));
  const areas: [string, string, string | null][] = [["A1", "Home", null], ["A2", "Garden", "A1"], ["A3", "Kitchen", "A1"], ["A4", "Work", null], ["A5", "Spare", null]];
  for (const [code, title, parent] of areas) {
    expect((await insertRow(v.app, v.settings, { table: "area", values: { code, title, ...(parent ? { parent: area(parent) } : {}) } })).ok).toBe(true);
  }
  expect((await insertRow(v.app, v.settings, { table: "person", values: { name: "Ada" } })).ok).toBe(true);
  const tasks: Record<string, unknown>[] = [
    { title: "Mow", status: "open", area: area("A2"), areas: [area("A2")], owner: "[[Ada]]", labels: ["outdoor"] },
    { title: "Paint", status: "done", area: area("A3"), areas: [area("A4"), area("A3")] },
    { title: "Report", status: "open", area: area("A4"), areas: [area("A4")] },
    { title: "Shop", status: "open" },
  ];
  for (const values of tasks) expect((await insertRow(v.app, v.settings, { table: "task", values })).ok).toBe(true);
  return v;
}

/** One vault for the whole file: every test only reads it (the CHECK is refused before any write). */
let v: DbVault;
beforeAll(async () => {
  v = await work();
});

const titles = async (where: Record<string, unknown>) =>
  (await select(v.app, v.settings, { table: "task", where, columns: ["title"], orderBy: "title" })).rows.map((r) => r.title);

describe("within", () => {
  it("names the root by link, file name, or the title of a row whose file has another name", async () => {
    expect(await titles({ area: { within: "Home" } })).toEqual(["Mow", "Paint"]);
    expect(await titles({ area: { within: "[[A1]]" } })).toEqual(["Mow", "Paint"]);
    expect(await titles({ area: { within: "A2" } })).toEqual(["Mow"]);
  });

  it("on a list of links, a row matches when any of its links is in the branch", async () => {
    expect(await titles({ areas: { within: "Home" } })).toEqual(["Mow", "Paint"]);
    expect(await titles({ areas: { within: "Work" } })).toEqual(["Paint", "Report"]);
  });

  it("refuses a root that is no row: an unknown name, a value that is not text", async () => {
    await expect(titles({ area: { within: "Nowhere" } })).rejects.toThrow(exactly(new OperationInputError(`"within": no row of main.work.area named "Nowhere"`)));
    await expect(titles({ area: { within: 5 } })).rejects.toThrow(exactly(new OperationInputError(`"within": no row of main.work.area named 5`)));
  });

  it("needs a link column with ref whose table has a hierarchy", async () => {
    await expect(titles({ owner: { within: "Ada" } })).rejects.toThrow(
      exactly(new OperationInputError(`"within": main.work.person has no hierarchy column (e.g. parent with hierarchy: true)`)),
    );
    await expect(titles({ labels: { within: "outdoor" } })).rejects.toThrow(exactly(new OperationInputError(`"within" needs a link column with ref: "labels" is not one`)));
  });

  it("is not available in a CHECK", async () => {
    await expect(addConstraint(v.app, v.settings, { table: "task", name: "home_only", check: { area: { within: "Home" } } })).rejects.toThrow(
      exactly(new OperationInputError(`"within" is not available here`)),
    );
  });
});

describe("dotted keys through a link", () => {
  it("two conditions through the same link column both apply", async () => {
    expect(await titles({ "area.title": { ne: "Garden" }, "area.parent": { exists: true } })).toEqual(["Paint"]);
  });

  it("a condition on the link column itself and one through it both apply", async () => {
    expect(await titles({ area: { exists: true }, "area.title": "Work" })).toEqual(["Report"]);
    expect(await titles({ area: { ne: area("A4") }, "area.title": "Work" })).toEqual([]);
  });

  it("join an `and` written before them", async () => {
    expect(await titles({ and: [{ status: "open" }], area: { exists: true }, "area.title": { in: ["Garden", "Kitchen"] } })).toEqual(["Mow"]);
  });
});

describe("icontains", () => {
  it.each([null, ["Mow"], { eq: "Mow" }])("a needle that is not a text or a number (%j) matches nothing", async (needle) => {
    expect(await titles({ title: { icontains: needle } })).toEqual([]);
  });
});

describe("logical keys", () => {
  it.each([
    [{ or: [] }, `"or" needs a non-empty list of where objects`],
    [{ and: { status: "open" } }, `"and" needs a non-empty list of where objects`],
    [{ not: null }, `"not" needs where objects, got null`],
    [{ not: [{ status: "open" }] }, `"not" needs where objects, got [{"status":"open"}]`],
    [{ or: [{ status: "open" }, "done"] }, `"or" needs where objects, got "done"`],
  ])("%j is refused", async (where, message) => {
    await expect(titles(where)).rejects.toThrow(exactly(new OperationInputError(message)));
  });
});

describe("file columns", () => {
  it("file_backlink_count counts the notes that link to a row, none included", async () => {
    const r = await select(v.app, v.settings, { table: "area", columns: ["code", "file_backlink_count"], orderBy: "code" });
    expect(r.rows.map((x) => [x.code, x.file_backlink_count])).toEqual([["A1", 2], ["A2", 1], ["A3", 1], ["A4", 2], ["A5", 0]]);
    const unlinked = await select(v.app, v.settings, { table: "area", columns: ["code"], where: { file_backlink_count: 0 } });
    expect(unlinked.rows.map((x) => x.code)).toEqual(["A5"]);
  });

  it("a row with no file yet (as a change set creates it) has no modification time, and no backlinks without the vault", async () => {
    const t = await loadTable(v.app, v.settings, "area");
    const fresh: LoadedRow = { file: { path: `${A}/A6.md` } as TFile, ordered: [["table", "main.work.area"], ["code", "A6"]] };
    const get = rowGetter(null, t, v.settings, "Europe/Rome");
    expect(["path", "code", "file_name", "file_link", "file_modified", "file_backlink_count"].map((c) => get(fresh, c))).toEqual([
      `${A}/A6.md`,
      "A6",
      "A6",
      `[[${A}/A6|A6]]`,
      null,
      null,
    ]);
    expect(rowGetter(v.app, t, v.settings, "Europe/Rome")(fresh, "file_backlink_count")).toBe(0);
  });
});

