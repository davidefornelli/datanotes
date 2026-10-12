/**
 * Checks of hand edits at their edges: nothing to check, notes whose frontmatter cannot be read,
 * rows moved to another table or created by hand, rows reaching several edited rows, CHECKs under
 * `not` or written wrong, link filters reading a table that is gone, lists of links to a removed
 * row, and the metastore checks that leave out generated values and missing inverse links.
 */

import { describe, expect, it } from "vitest";
import { ChangeFeed, type ChangeEvent } from "../src/core/change-feed";
import { INDEX_RETRY } from "../src/core/engine";
import { checkChangedTables, checkExternalEdits } from "../src/core/external-edits";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
/**
 * `project` (kind area / project; `owner` links to a table that was dropped); `task`: `project`
 * (a project, never an area: CHECK not_area; CHECK typo reads a column projects lack),
 * `projects` (only kind project), `lead` (filtered by the owner's kind: cannot be checked),
 * `related` (any projects).
 */
const TABLES = `project:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string, required: true, dense: true }
    - { name: kind, type: enum, values: [area, project], dense: true }
    - { name: owner, type: link, ref: main.public.team }
task:
  options: { filename: "{title}" }
  constraints:
    not_area: { not: { "project.kind": area } }
    typo: { "project.nope": 1 }
  columns:
    - ${ID}
    - { name: title, type: string, required: true, dense: true }
    - { name: project, type: link, ref: main.public.project }
    - { name: projects, type: list, items: link, ref: main.public.project, ref_where: { kind: project } }
    - { name: lead, type: link, ref: main.public.project, ref_where: { "owner.kind": x } }
    - { name: related, type: list, items: link, ref: main.public.project }
entry:
  options: { filename: "{title}" }
  columns:
    - ${ID}
    - { name: title, type: string, required: true, dense: true }
    - { name: log, type: link, ref: main.public.log }
`;

const PR = "Prj";
const TK = "Tsk";
let n = 0;
const uuid = () => `01a0f000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const project = (name: string, kind: string, id = uuid()) => `---\ntable: main.public.project\nid: ${id}\nname: ${name}\nkind: ${kind}\n---\n`;
const task = (title: string, extra: string) => `---\ntable: main.public.task\nid: ${uuid()}\ntitle: ${title}\n${extra}---\n`;

const SITE_ID = "01a0f000-0000-7000-8000-0000000000f1";
const SHOP_ID = "01a0f000-0000-7000-8000-0000000000f2";

async function vault(extra: Record<string, string> = {}): Promise<{ v: DbVault; feed: ChangeFeed }> {
  const v = createDbVault({
    [METASTORE]: withTables(TABLES),
    [`${PR}/Home.md`]: project("Home", "area"),
    [`${PR}/Site.md`]: project("Site", "project", SITE_ID),
    [`${PR}/Shop.md`]: project("Shop", "project", SHOP_ID),
    [`${TK}/Lead.md`]: task("Lead", 'lead: "[[Site]]"\n'),
    [`${TK}/Paint.md`]: task("Paint", 'project: "[[Site]]"\nprojects: ["[[Site]]", "[[Shop]]"]\nrelated: ["[[Shop]]"]\n'),
    ...extra,
  });
  const feed = new ChangeFeed(v.app, () => v.settings);
  await feed.start();
  return { v, feed };
}

/** Write (or delete: null) notes by hand, one batch; the new events. */
async function handEdit(v: DbVault, feed: ChangeFeed, notes: Record<string, string | null>): Promise<ChangeEvent[]> {
  const since = feed.lastSeq;
  for (const [p, text] of Object.entries(notes)) {
    if (text === null) v.remove(p);
    else v.write(p, text);
    feed.touch(p);
  }
  await feed.flush();
  return (await feed.read({ since })).events;
}

describe("nothing to check", () => {
  it("no edits: no metastore read, no table loaded", async () => {
    const { v, feed } = await vault();
    expect(await checkExternalEdits(v.app, v.settings, [])).toEqual({ byPath: new Map(), loaded: [], tableOf: new Map() });
    await feed.stop();
  });

  it("a note whose frontmatter cannot be read is no row until fixed", async () => {
    const { v, feed } = await vault();
    v.write("Notes/bad.md", "---\ntable: main.public.task\ntitle: [Broken\n---\n");
    expect(await checkExternalEdits(v.app, v.settings, [{ path: "Notes/bad.md", before: null }])).toEqual({ byPath: new Map(), loaded: [], tableOf: new Map() });
    await feed.stop();
  });
});

describe("rows that link to an edited row", () => {
  it("a CHECK under `not` that follows a link names the edit; a CHECK written wrong is left to check_table", async () => {
    const { v, feed } = await vault();
    const [site] = await handEdit(v, feed, { [`${PR}/Site.md`]: project("Site", "area", SITE_ID) });
    expect(site!.violations).toEqual([
      { path: `${TK}/Paint.md`, code: "check", constraint: "not_area", message: "violates CHECK not_area (after the edit of [[Site]], a row it links to)" },
      {
        path: `${TK}/Paint.md`,
        code: "ref",
        column: "projects",
        message: `[[Site]] is not a valid target in projects (needs ref_where {"kind":"project"}); valid: Shop (after the edit of [[Site]], a row it links to)`,
      },
    ]);
    await feed.stop();
  });

  it("a row reaching several edited rows names them all", async () => {
    const { v, feed } = await vault();
    const events = await handEdit(v, feed, { [`${PR}/Site.md`]: project("Site", "area", SITE_ID), [`${PR}/Shop.md`]: project("Shop", "area", SHOP_ID) });
    const message = `[[Site]], [[Shop]] are not valid targets in projects (needs ref_where {"kind":"project"}); valid: none (after the edit of [[Shop]], the edit of [[Site]], rows it links to)`;
    expect(events.map((e) => [e.path, e.violations!.filter((x) => x.column === "projects")])).toEqual([
      [`${PR}/Site.md`, [{ path: `${TK}/Paint.md`, code: "ref", column: "projects", message }]],
      [`${PR}/Shop.md`, [{ path: `${TK}/Paint.md`, code: "ref", column: "projects", message }]],
    ]);
    await feed.stop();
  });

  it("a row created by hand that a link already named: what the link now breaks is the edit's", async () => {
    const { v, feed } = await vault({ [`${TK}/Order.md`]: task("Order", 'projects: ["[[Garden]]"]\n') });
    const [garden] = await handEdit(v, feed, { [`${PR}/Garden.md`]: project("Garden", "area") });
    expect(garden!.op).toBe("insert");
    expect(garden!.violations).toEqual([
      {
        path: `${TK}/Order.md`,
        code: "ref",
        column: "projects",
        message: `[[Garden]] is not a valid target in projects (needs ref_where {"kind":"project"}); valid: Shop, Site (after the edit of [[Garden]], a row it links to)`,
      },
    ]);
    await feed.stop();
  });

  it("a row moved to another table breaks the links that need a row of its first table", async () => {
    const LOG_ROW = "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-0000000000e1\nkind: walk\noccurred_at: 2026-09-27T10:00\n---\n";
    const { v, feed } = await vault({
      "Notes/walk.md": LOG_ROW,
      "Notes/Diary.md": "---\ntable: main.public.entry\nid: 01a0f000-0000-7000-8000-0000000000e2\ntitle: Diary\nlog: \"[[walk]]\"\n---\n",
    });
    const events = await handEdit(v, feed, { "Notes/walk.md": project("walk", "project", "01a0f000-0000-7000-8000-0000000000e1") });
    expect(events.map((e) => [e.op, e.table])).toEqual([
      ["delete", "main.public.log"],
      ["insert", "main.public.project"],
    ]);
    expect(events[1]!.violations).toEqual([
      { path: "Notes/Diary.md", code: "ref", column: "log", message: expect.stringMatching(/main\.public\.log.* \(after the edit of \[\[walk\]\], a row it links to\)$/) },
    ]);
    await feed.stop();
  });

  it("a removed row breaks the lists of links that named it", async () => {
    const { v, feed } = await vault();
    const [shop] = await handEdit(v, feed, { [`${PR}/Shop.md`]: null });
    expect(shop!.op).toBe("delete");
    expect(shop!.violations).toEqual([
      { path: `${TK}/Paint.md`, code: "broken_link", column: "projects", message: "[[Shop]] is not a row of main.public.project; valid: Site (after the removal of [[Shop]], a row it links to)" },
      { path: `${TK}/Paint.md`, code: "broken_link", column: "related", index: 0, message: "link does not resolve: Shop (after the removal of [[Shop]], a row it links to)" },
    ]);
    await feed.stop();
  });
});

describe("checkChangedTables", () => {
  it("lists what every row of the tables breaks, without stale generated values or missing inverse links", async () => {
    const PEOPLE = `person:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string, required: true, dense: true }
    - { name: label, type: string, generated: "{name}!" }
    - { name: friends, type: list, items: link, ref: self, inverse: friends }
    - { name: age, type: integer, min: 0 }
`;
    const person = (name: string, extra: string) => `---\ntable: main.public.person\nid: ${uuid()}\nname: ${name}\n${extra}---\n`;
    const v = createDbVault({
      [METASTORE]: withTables(PEOPLE),
      "P/Ann.md": person("Ann", 'label: "Old!"\nfriends: ["[[Bob]]"]\n'),
      "P/Bob.md": person("Bob", "label: Bob!\nage: -1\n"),
    });
    const r = await checkChangedTables(v.app, v.settings, ["main.public.person"]);
    expect(r).toEqual({
      byTable: new Map([["main.public.person", [{ path: "P/Bob.md", code: "min", column: "age", message: expect.stringContaining("0") }]]]),
      errors: new Map(),
    });
  });
});
