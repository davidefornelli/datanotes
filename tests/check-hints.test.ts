/**
 * CHECK hints (`add_constraint` `hint`): stored in `constraint_hints`, carried by the violations of
 * the CHECK, first in a refused write's hint, listed by describe_table and information_schema.
 */

import { describe, expect, it } from "vitest";
import { operationRequest, ROUTE_PREFIX } from "../src/api/requests";
import { addConstraint, dropConstraint } from "../src/core/catalog-ops";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { docsUrl, violationGuidance } from "../src/core/hints";
import { constraintHints } from "../src/core/metastore";
import { describeTable } from "../src/core/public-api";
import { checkTable, insertRow, select, updateRow } from "../src/core/rows";
import { createHandlers, dispatch } from "../src/server/rest";
import { createDbVault, METASTORE, type DbVault } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

INDEX_RETRY.delayMs = 1;

const HINT = "A watched film needs a rating: ask for it.";
const CHECK = { or: [{ status: { ne: "watched" } }, { rating: { exists: true } }] };
const FILM = {
  name: "film",
  description: "Films I watched",
  columns: [
    { name: "title", type: "string", required: true, description: "The film's title" },
    { name: "status", type: "enum", values: ["to watch", "watched"], description: "Where the film is" },
    { name: "rating", type: "integer", min: 1, max: 5, description: "My rating" },
  ],
  options: { filename: "{title}" },
};

async function vault(hint: string | undefined = HINT): Promise<DbVault> {
  const v = createDbVault({});
  const r = await createTable(v.app, v.settings, described(FILM) as never);
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  const c = await addConstraint(v.app, v.settings, { table: "film", name: "rated", check: CHECK, ...(hint !== undefined ? { hint } : {}) } as never);
  expect(c.ok, JSON.stringify(c)).toBe(true);
  return v;
}

async function call(v: DbVault, op: string, args: Record<string, unknown>) {
  const handlers = createHandlers(v.app, () => v.settings);
  const req = operationRequest(op, args);
  const route = req.path.slice(ROUTE_PREFIX.length);
  return (await dispatch(route, handlers[route]!, req.body)) as { status: number; json: Record<string, any> };
}

describe("CHECK hints", () => {
  it("constraintHints keeps text hints of CHECKs the table has", () => {
    const checks = { a: {}, b: {}, c: {}, d: {}, e: {}, constructor: {} };
    expect(constraintHints({})).toEqual({});
    expect(constraintHints({ constraints: checks, constraint_hints: [] as never })).toEqual({});
    expect(constraintHints({ constraints: checks, constraint_hints: "x" as never })).toEqual({});
    expect(
      constraintHints({
        constraints: checks,
        constraint_hints: { a: "  Fix it.  ", b: 5, c: "   ", d: ["x"], gone: "Unknown CHECK", constructor: "Named like a built-in" } as never,
      }),
    ).toEqual({ a: "Fix it.", constructor: "Named like a built-in" });
    // `toString` is not an own name of the CHECKs
    expect(constraintHints({ constraints: {}, constraint_hints: { toString: "x" } })).toEqual({});
  });

  it("add_constraint stores the hint in constraint_hints, describe_table lists it, constraints keep their shape", async () => {
    const v = await vault();
    expect(v.read(METASTORE)).toContain("constraint_hints:");
    const d = await describeTable(v.app, v.settings, "film");
    expect(d.constraint_hints).toEqual({ rated: HINT });
    expect(d.constraints).toEqual({ rated: CHECK });
  });

  it("a refused write carries the CHECK's hint on the violation and first in the refusal's hint", async () => {
    const v = await vault();
    const r = await call(v, "insert_row", { table: "film", values: { title: "Metropolis", status: "watched" } });
    expect(r.status).toBe(422);
    expect(r.json.violations[0].violations[0].hint).toBe(HINT);
    expect(r.json.hint.startsWith(HINT)).toBe(true);
    expect(r.json.hint).toContain(violationGuidance("check").hint);
    expect(r.json.docs).toBe(docsUrl("check"));
  });

  it("a CHECK that follows links gives its hint too", async () => {
    const v = createDbVault({});
    const made = await createTable(
      v.app,
      v.settings,
      described({
        name: "project",
        columns: [
          { name: "name", type: "string", required: true },
          { name: "kind", type: "enum", values: ["area", "project"], required: true },
          { name: "parent", type: "link", ref: "self" },
        ],
        options: { filename: "{name}" },
      }) as never,
    );
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const own = "A project sits under an area: link its parent to an area.";
    const c = await addConstraint(v.app, v.settings, {
      table: "project",
      name: "parent_by_level",
      check: { or: [{ kind: "area", parent: { exists: false } }, { kind: "project", "parent.kind": "area" }] },
      hint: own,
    } as never);
    expect(c.ok, JSON.stringify(c)).toBe(true);
    const dir = "Datanotes/main/public/project";
    const add = (values: Record<string, unknown>) => insertRow(v.app, v.settings, { table: "project", values } as never);
    expect((await add({ name: "Home", kind: "area" })).ok).toBe(true);
    expect((await add({ name: "Site", kind: "project", parent: "[[Home]]" })).ok).toBe(true);
    const shop = await add({ name: "Shop", kind: "project", parent: "[[Site]]" });
    expect(shop.ok).toBe(false);
    expect(shop.violations.flatMap((x) => x.violations).find((x) => x.code === "check")?.hint).toBe(own);
    const home = await updateRow(v.app, v.settings, { table: "project", path: `${dir}/Home.md`, set: { kind: "project" }, unset: ["parent"] } as never);
    expect(home.ok).toBe(false);
    const forSite = home.violations.find((x) => x.path === `${dir}/Site.md`);
    expect(forSite?.violations.find((x) => x.code === "check")?.hint).toBe(own);
  });

  it("check_table reports the hint", async () => {
    const v = await vault();
    // a row that breaks the rule, written by hand
    v.write("Datanotes/main/public/film/Old.md", "---\ntable: main.public.film\ntitle: Old\nstatus: watched\n---\n");
    const c = await checkTable(v.app, v.settings, { table: "film" });
    const bad = c.violations.find((r) => r.path.endsWith("Old.md"));
    expect(bad?.violations.find((x) => x.code === "check")?.hint).toBe(HINT);
  });

  it("information_schema.check_constraints has the hint, null without one", async () => {
    const v = await vault();
    const more = await addConstraint(v.app, v.settings, { table: "film", name: "other", check: { rating: { lte: 5 } } });
    expect(more.ok).toBe(true);
    const rows = await select(v.app, v.settings, {
      table: "system.information_schema.check_constraints",
      columns: ["constraint_name", "hint"],
    } as never);
    const byName = Object.fromEntries((rows.rows as Record<string, unknown>[]).map((r) => [r.constraint_name, r.hint]));
    expect(byName).toEqual({ rated: HINT, other: null });
  });

  it("drop_constraint removes the hint; add_constraint without hint stores none; a blank hint is none", async () => {
    const v = await vault();
    const none = await addConstraint(v.app, v.settings, { table: "film", name: "plain", check: { rating: { lte: 5 } } });
    expect(none.ok).toBe(true);
    const blank = await addConstraint(v.app, v.settings, { table: "film", name: "blank", check: { rating: { gte: 1 } }, hint: "   " });
    expect(blank.ok).toBe(true);
    expect((await describeTable(v.app, v.settings, "film")).constraint_hints).toEqual({ rated: HINT });
    expect((await dropConstraint(v.app, v.settings, { table: "film", name: "rated" })).ok).toBe(true);
    const d = await describeTable(v.app, v.settings, "film");
    expect("constraint_hints" in d).toBe(false);
    expect(Object.keys(d.constraints ?? {}).sort()).toEqual(["blank", "plain"]);
    expect(v.read(METASTORE)).not.toContain("constraint_hints");
    // the same name again: no stale hint comes back
    await addConstraint(v.app, v.settings, { table: "film", name: "rated", check: CHECK });
    expect("constraint_hints" in (await describeTable(v.app, v.settings, "film"))).toBe(false);
    const bad = () => addConstraint(v.app, v.settings, { table: "film", name: "bad", check: CHECK, hint: 5 as never });
    await expect(bad()).rejects.toThrow(/"hint" must be text/);
    await expect(bad()).rejects.toMatchObject({ hint: expect.any(String), docs: docsUrl("check") });
  });

  it("a batch's refused step keeps the hint on its violation", async () => {
    const v = await vault();
    const r = await call(v, "batch", {
      operations: [
        { op: "insert_row", table: "film", values: { title: "Fine", status: "to watch" } },
        { op: "insert_row", table: "film", values: { title: "Bad", status: "watched" } },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.json.failed_at).toBe(1);
    expect(JSON.stringify(r.json)).toContain(JSON.stringify(HINT).slice(1, -1));
    expect(r.json.steps[1].result.violations[0].violations[0].hint).toBe(HINT);
  });
});
