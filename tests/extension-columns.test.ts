import { describe, expect, it } from "vitest";
import { ColumnBinder } from "../src/api/extension-columns";
import type { ExtensionManifest, ManifestColumn } from "../src/api/extension-manifest";

const col = (name: string, extra: Record<string, unknown> = {}): ManifestColumn => ({ name, type: "string", description: name, need: "required", ...extra });
const link = (name: string, ref: string, extra: Record<string, unknown> = {}): ManifestColumn => col(name, { type: "link", ref, ...extra });

/**
 * Two dependencies, person and place, and two owned roles: meal → person, place; meal_item → meal.
 * person.name is bound to full_name, place.opened to opened_on.
 */
const MANIFEST: Pick<ExtensionManifest, "tables"> = {
  tables: {
    person: { owned: false, description: "p", columns: [col("name"), link("partner", "self"), col("nick")] },
    place: { owned: false, description: "l", columns: [col("opened"), col("city")] },
    meal: { owned: true, description: "m", columns: [col("started_at"), link("person", "@person"), link("place", "@place"), col("kind")] },
    meal_item: { owned: true, description: "i", columns: [link("meal", "@meal"), { ...col("foods"), type: "list", items: "link", ref: "@person" }, col("eaten")] },
  },
};
const MAP = { person: { name: "full_name", nick: "nick" }, place: { opened: "opened_on" } };
const binder = () => new ColumnBinder(MANIFEST, MAP);

describe("ColumnBinder: names and paths", () => {
  it("keeps only the columns bound to another name", () => {
    const b = binder();
    expect(b.mapped("person")).toEqual(["name"]);
    expect(b.mapped("meal")).toEqual([]);
    expect(b.name("person", "nick")).toBe("nick");
    expect(b.empty).toBe(false);
    expect(new ColumnBinder(MANIFEST, { person: { nick: "nick" } }).empty).toBe(true);
  });

  it("follows link columns from role to role, list links and self links included", () => {
    const b = binder();
    expect(b.path("person", "name")).toBe("full_name");
    expect(b.path("meal", "person.name")).toBe("person.full_name");
    expect(b.path("meal", "place.opened")).toBe("place.opened_on");
    expect(b.path("meal_item", "meal.person.name")).toBe("meal.person.full_name");
    expect(b.path("meal_item", "foods.name")).toBe("foods.full_name");
    expect(b.path("person", "partner.name")).toBe("partner.full_name");
    // a part that is not a link column ends the walk: what follows keeps its name
    expect(b.path("meal", "kind.name")).toBe("kind.name");
    expect(b.path("meal", "name")).toBe("name");
    expect(b.path(null, "name")).toBe("name");
  });

  it("rewrites date expressions with their shift", () => {
    const b = binder();
    expect(b.expr("meal", "date(place.opened)")).toBe("date(place.opened_on)");
    expect(b.expr("place", "date(opened)-1")).toBe("date(opened_on)-1");
    expect(b.expr("meal", "path")).toBe("path");
  });
});

describe("ColumnBinder: where filters and CHECKs", () => {
  it("rewrites keys, nested or / and / not, and leaves values alone", () => {
    const where = {
      started_at: { gte: "{today-7d}" },
      "person.name": { icontains: "name" },
      or: [{ kind: "pranzo" }, { not: { "place.opened": { exists: false } } }],
      and: { "person.name": "Ada" },
      path: "x",
    };
    expect(binder().where("meal", where)).toEqual({
      started_at: { gte: "{today-7d}" },
      "person.full_name": { icontains: "name" },
      or: [{ kind: "pranzo" }, { not: { "place.opened_on": { exists: false } } }],
      and: { "person.full_name": "Ada" },
      path: "x",
    });
  });

  it("returns non-objects and filters on an unknown table as they are", () => {
    expect(binder().where("meal", null)).toBeNull();
    expect(binder().where(null, { name: 1 })).toEqual({ name: 1 });
  });
});

describe("ColumnBinder: column specs", () => {
  it("rewrites ref_where on the target role, ref_by on both sides and inverse on the target", () => {
    const b = binder();
    expect(b.column("meal", link("person", "@person", { ref_where: { name: { exists: true } } })).ref_where).toEqual({ full_name: { exists: true } });
    expect(b.column("meal", link("place", "@place", { ref_by: { column: "kind", target_column: "opened", levels: ["a"] } })).ref_by).toEqual({
      column: "kind",
      target_column: "opened_on",
      levels: ["a"],
    });
    // the same name on both sides once bound: no target_column
    expect(b.column("person", link("partner", "self", { ref_by: { column: "name" } })).ref_by).toEqual({ column: "full_name" });
    expect(b.column("person", link("partner", "self", { inverse: "name" })).inverse).toBe("full_name");
    expect(b.column("meal", link("place", "@place", { inverse: "opened" })).inverse).toBe("opened_on");
  });

  it("changes nothing when no column is bound to another name", () => {
    const c = link("person", "@person", { ref_where: { name: 1 } });
    expect(new ColumnBinder(MANIFEST, {}).column("meal", c)).toBe(c);
  });
});

describe("ColumnBinder: view queries", () => {
  it("rewrites every clause of a select", () => {
    const b = binder();
    const q = {
      table: "@meal",
      columns: ["started_at", "person.name", "n"],
      where: { "place.opened": { gte: "{today}" } },
      order_by: ["-person.name", "n"],
      group_by: ["person", "date(place.opened)+1"],
      aggregates: { n: "count", first: "min:place.opened", who: "count:person.name" },
      expand: ["person"],
      limit: 10,
      include_body: false,
    };
    expect(b.query("vw_meals", q)).toEqual({
      table: "@meal",
      columns: ["started_at", "person.full_name", "n"],
      where: { "place.opened_on": { gte: "{today}" } },
      order_by: ["-person.full_name", "n"],
      group_by: ["person", "date(place.opened_on)+1"],
      aggregates: { n: "count", first: "min:place.opened_on", who: "count:person.full_name" },
      expand: ["person"],
      limit: 10,
      include_body: false,
    });
    expect(b.issues).toEqual([]);
  });

  it("keeps an aggregate's name that is also a column's, and a single order_by or group_by", () => {
    const q = { table: "@place", group_by: "date(opened)", aggregates: { opened: "min:opened" }, order_by: "-opened" };
    expect(binder().query("v", q)).toEqual({ table: "@place", group_by: "date(opened_on)", aggregates: { opened: "min:opened_on" }, order_by: "-opened" });
  });

  it("rewrites a join: the left side of `on` on the view's table, the right side, columns and where on the joined one", () => {
    const q = {
      table: "@meal",
      join: { table: "@place", on: { "date(started_at)": "date(opened)" }, as: "p", type: "left", columns: ["opened", "city"], where: { city: "x", opened: 1 } },
    };
    expect(binder().query("v", q).join).toEqual({
      table: "@place",
      on: { "date(started_at)": "date(opened_on)" },
      as: "p",
      type: "left",
      columns: ["opened_on", "city"],
      where: { city: "x", opened_on: 1 },
    });
  });

  it("rewrites the parts of a union and reports a mapped column in its outer clauses", () => {
    const b = binder();
    const q = { union: [{ table: "@place", columns: ["opened"], where: { opened: 1 } }, { table: "@meal", columns: ["person.name"] }], columns: ["opened"], order_by: "person.name" };
    expect(b.query("vw_all", q).union).toEqual([{ table: "@place", columns: ["opened_on"], where: { opened_on: 1 } }, { table: "@meal", columns: ["person.full_name"] }]);
    expect(b.issues).toEqual([
      { role: "place", column: "opened", where: "view vw_all (union columns)" },
      { role: "person", column: "name", where: "view vw_all (union order_by)" },
    ]);
  });

  it("reports a mapped column under a key it does not know, and keeps the key", () => {
    const b = binder();
    const q = { table: "@place", having: { opened: 1 }, join: { table: "@person", on: {}, extra: "name" }, union_like: "nothing mapped" };
    const out = b.query("v", q);
    expect(out.having).toEqual({ opened: 1 });
    expect(b.issues).toEqual([
      { role: "place", column: "opened", where: "view v (having)" },
      { role: "person", column: "name", where: "view v (join.extra)" },
    ]);
  });

  it("passes values of a shape it does not rewrite through as they are", () => {
    const b = binder();
    const odd = {
      table: "@person",
      columns: ["name", 1],
      expand: "partner",
      order_by: [2, "name"],
      group_by: ["name", 3],
      aggregates: { n: 4 },
      join: { table: 5, on: { name: 6 }, columns: ["city", 7] },
    };
    expect(b.query("v", odd)).toEqual({
      table: "@person",
      columns: ["full_name", 1],
      expand: "partner",
      order_by: [2, "full_name"],
      group_by: ["full_name", 3],
      aggregates: { n: 4 },
      join: { table: 5, on: { full_name: 6 }, columns: ["city", 7] },
    });
    expect(b.query("v", { table: "@person", group_by: 1, aggregates: 2, join: 3 })).toEqual({ table: "@person", group_by: 1, aggregates: 2, join: 3 });
    const union = { union: [8, { table: "@person", columns: ["name", 9], limit: 1, extra: "name" }] };
    expect(b.query("vu", union).union).toEqual([8, { table: "@person", columns: ["full_name", 9], limit: 1, extra: "name" }]);
    // a key a union part does not know is kept, and reported when it names a mapped column
    expect(b.issues).toEqual([{ role: "person", column: "name", where: "view vu (union.extra)" }]);
    // a column with a ref that is not a link column ends a path
    const notLink: Pick<ExtensionManifest, "tables"> = { tables: { meal: { owned: true, description: "m", columns: [col("person", { ref: "@person" })] }, person: MANIFEST.tables.person! } };
    expect(new ColumnBinder(notLink, MAP).path("meal", "person.name")).toBe("person.name");
  });

  it("leaves a query on a table that is not a role, and every query when nothing is bound", () => {
    const q = { table: "base:record", columns: ["name"] };
    expect(binder().query("v", q)).toEqual(q);
    const same = { table: "@person", columns: ["name"] };
    expect(new ColumnBinder(MANIFEST, {}).query("v", same)).toBe(same);
  });
});

describe("ColumnBinder: named", () => {
  it("finds a mapped column of a named role, or at the end of a link path under any role", () => {
    const b = binder();
    const all = () => true;
    expect(b.named({ check: { "person.name": 1 } }, [], all)).toEqual([{ role: "person", column: "name" }]);
    expect(b.named("opened", ["place"], all)).toEqual([{ role: "place", column: "opened" }]);
    // a plain word names a column only of the roles given
    expect(b.named("opened", ["person"], all)).toEqual([]);
    // keys count only where `keys` says so
    expect(b.named({ opened: 1 }, ["place"], () => false)).toEqual([]);
    expect(b.named({ check: { opened: 1 } }, ["place"], (k, inKeys) => inKeys || k === "check")).toEqual([{ role: "place", column: "opened" }]);
  });
});
