/**
 * resolveWithin keeps every key of a where, whatever their order: a dotted key on a link column the
 * where also tests goes into `and`, also when an `and` key follows it.
 */

import { describe, expect, it } from "vitest";
import { INDEX_RETRY } from "../src/core/engine";
import { select } from "../src/core/rows";
import { createDbVault, METASTORE, withTables } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
const TABLES = `area:
  options: { filename: "{title}" }
  columns:
    - ${ID}
    - { name: title, type: string }
    - { name: kind, type: enum, values: [home, work] }
task:
  options: { filename: "{title}" }
  columns:
    - ${ID}
    - { name: title, type: string }
    - { name: area, type: link, ref: main.public.area }
    - { name: done, type: boolean }
`;

const row = (table: string, n: number, fields: string) => `---\ntable: main.public.${table}\nid: 01a0f000-0000-7000-8000-0000000000${n}\n${fields}---\n`;

describe("a dotted key with an and", () => {
  it("is kept whatever the order of the keys", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(TABLES),
      "Areas/House.md": row("area", 11, "title: House\nkind: home\n"),
      "Areas/Office.md": row("area", 12, "title: Office\nkind: work\n"),
      "Tasks/Dishes.md": row("task", 21, 'title: Dishes\narea: "[[House]]"\ndone: false\n'),
      "Tasks/Report.md": row("task", 22, 'title: Report\narea: "[[Office]]"\ndone: false\n'),
      "Tasks/Roof.md": row("task", 23, 'title: Roof\narea: "[[House]]"\ndone: true\n'),
    });
    const area = { in: ["[[House]]", "[[Office]]"] };
    const wheres = [
      { area, "area.kind": "work", and: [{ done: false }] },
      { and: [{ done: false }], area, "area.kind": "work" },
      { "area.kind": "work", area, and: [{ done: false }] },
      { "area.kind": "work", "area.title": "Office", and: [{ done: false }] },
    ];
    for (const where of wheres) {
      const r = await select(v.app, v.settings, { table: "task", where, columns: ["title"] });
      expect(r.rows.map((x) => x.title), JSON.stringify(where)).toEqual(["Report"]);
    }
  });
});
