import { describe, expect, it } from "vitest";
import { OPERATORS as ENGINE_OPERATORS } from "../src/core/where";
import { conditionsToWhere, OPERATORS, whereToConditions, type Condition } from "../src/ui/lib/where";

const types = { status: "enum", estimate_h: "number", n: "integer", flag: "boolean", due: "date", project: "link" };
const c = (column: string, op: Condition["op"], value: string): Condition => ({ column, op, value });

describe("OPERATORS", () => {
  it("are the engine's operators", () => {
    expect(new Set(OPERATORS)).toEqual(new Set(ENGINE_OPERATORS));
  });
});

describe("conditionsToWhere", () => {
  it("writes eq alone on a column as the plain value", () => {
    expect(conditionsToWhere([c("status", "eq", "todo")], types)).toEqual({ where: { status: "todo" }, errors: [] });
  });

  it("writes every other operator as an operator object", () => {
    for (const op of ["ne", "gt", "gte", "lt", "lte", "contains", "icontains", "within"] as const) {
      expect(conditionsToWhere([c("project", op, "Design")], types).where).toEqual({ project: { [op]: "Design" } });
    }
  });

  it("merges the conditions of one column, eq included", () => {
    expect(conditionsToWhere([c("estimate_h", "gte", "5"), c("estimate_h", "lt", "20"), c("estimate_h", "eq", "8")], types).where).toEqual({
      estimate_h: { gte: 5, lt: 20, eq: 8 },
    });
  });

  it("parses numbers, integers and booleans by the column's type", () => {
    expect(conditionsToWhere([c("estimate_h", "gte", " 2.5 "), c("n", "eq", "3"), c("flag", "eq", "false"), c("due", "lt", "2026-11-01")], types).where).toEqual({
      estimate_h: { gte: 2.5 },
      n: 3,
      flag: false,
      due: { lt: "2026-11-01" },
    });
    expect(conditionsToWhere([c("flag", "ne", "true")], types).where).toEqual({ flag: { ne: true } });
    expect(conditionsToWhere([c("other", "eq", "x")], types).where).toEqual({ other: "x" });
  });

  it("splits in on commas and parses each item", () => {
    expect(conditionsToWhere([c("status", "in", "todo, doing ,done")], types).where).toEqual({ status: { in: ["todo", "doing", "done"] } });
    expect(conditionsToWhere([c("n", "in", "1,2")], types).where).toEqual({ n: { in: [1, 2] } });
  });

  it("takes true or false for exists", () => {
    expect(conditionsToWhere([c("due", "exists", "true"), c("project", "exists", " false")], types).where).toEqual({
      due: { exists: true },
      project: { exists: false },
    });
    expect(conditionsToWhere([c("due", "exists", "yes")], types)).toEqual({ where: {}, errors: ['"due": exists takes true or false'] });
  });

  it("says why a condition cannot be sent", () => {
    const r = conditionsToWhere(
      [c("estimate_h", "gt", "lots"), c("n", "in", "1,x"), c("flag", "eq", "maybe"), c("", "eq", "x"), c("estimate_h", "gt", ""), c("status", "eq", "a"), c("status", "eq", "b")],
      types,
    );
    expect(r.errors).toEqual([
      '"estimate_h": "lots" is not a number',
      '"n": "x" is not a number',
      '"flag": "maybe" is not true or false',
      "Pick a column for every condition",
      '"estimate_h": "" is not a number',
      '"status": the operator eq is used twice',
    ]);
    expect(r.where).toEqual({ status: "a" });
  });
});

describe("whereToConditions", () => {
  it("reads plain values and operator objects", () => {
    expect(whereToConditions({ status: "todo", estimate_h: { gte: 5, lt: 20 }, flag: true, n: 3 })).toEqual([
      c("status", "eq", "todo"),
      c("estimate_h", "gte", "5"),
      c("estimate_h", "lt", "20"),
      c("flag", "eq", "true"),
      c("n", "eq", "3"),
    ]);
    expect(whereToConditions({ status: { in: ["todo", "doing"] } })).toEqual([c("status", "in", "todo, doing")]);
    expect(whereToConditions({})).toEqual([]);
  });

  it("is null for what needs the JSON mode", () => {
    expect(whereToConditions({ and: [{ status: "todo" }] })).toBeNull();
    expect(whereToConditions({ or: [] })).toBeNull();
    expect(whereToConditions({ not: { status: "todo" } })).toBeNull();
    expect(whereToConditions({ status: { foo: 1 } })).toBeNull();
    expect(whereToConditions({ status: {} })).toBeNull();
    expect(whereToConditions({ status: null })).toBeNull();
    expect(whereToConditions({ tags: ["a"] })).toBeNull();
    expect(whereToConditions({ status: { in: "todo" } })).toBeNull();
    expect(whereToConditions({ status: { in: ["a,b"] } })).toBeNull();
    expect(whereToConditions({ status: { in: [{ x: 1 }] } })).toBeNull();
    expect(whereToConditions({ status: { eq: { x: 1 } } })).toBeNull();
  });

  it("round-trips the conditions it builds", () => {
    const conds = [c("status", "in", "todo, doing"), c("estimate_h", "gte", "5"), c("estimate_h", "lte", "9"), c("due", "exists", "true"), c("project", "eq", "[[Design system]]")];
    const { where, errors } = conditionsToWhere(conds, types);
    expect(errors).toEqual([]);
    expect(whereToConditions(where)).toEqual(conds);
    expect(conditionsToWhere(whereToConditions(where)!, types).where).toEqual(where);
  });
});
