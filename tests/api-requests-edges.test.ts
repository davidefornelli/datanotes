import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/api/catalog";
import { CALLABLE_OPERATIONS, OperationInputError, operationRequest, operationRoute } from "../src/api/requests";
import { guidedTextOf } from "./helpers/guidance";

/** The error `fn` throws (fails the test when it does not throw). */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected an error");
}

describe("operationRequest", () => {
  it("is POST /datanotes/operations/<name>/ with the arguments as they are, for every operation", () => {
    for (const { name } of OPERATIONS) expect(operationRequest(name, { table: "log" })).toEqual({ method: "POST", path: `/datanotes/operations/${name}/`, body: { table: "log" } });
  });

  it("leaves out the arguments not given (null or undefined) and keeps the others as they are", () => {
    const args = { table: "main.home.items", paths: ["Home/Drill.md"], rename: { date: "bought_on" }, set: { zone: "[[Garage]]" }, relocate: false, dry_run: true, body: "", where: null, limit: undefined };
    expect(operationRequest("adopt_rows", args)).toEqual({
      method: "POST",
      path: "/datanotes/operations/adopt_rows/",
      body: { table: "main.home.items", paths: ["Home/Drill.md"], rename: { date: "bought_on" }, set: { zone: "[[Garage]]" }, relocate: false, dry_run: true, body: "" },
    });
    expect(operationRequest("list_tables")).toEqual({ method: "POST", path: "/datanotes/operations/list_tables/", body: {} });
  });

  it.each([["drop_everything"], ["toString"], ["constructor"], ["__proto__"], ["semantic_index"]])("refuses %s: not an operation", (name) => {
    const e = thrown(() => operationRequest(name, {}));
    expect(e).toBeInstanceOf(OperationInputError);
    expect(e.name).toBe("OperationInputError");
    // the message ends with how to fix it and the operations' reference
    expect(e.message).toEqual(guidedTextOf(`unknown operation: ${name}`));
  });

  it("names the closest operation of a misspelled one", () => {
    expect(thrown(() => operationRequest("select_row")).message).toMatch(/\nHint: Did you mean "select_rows"\?/);
  });
});

describe("operationRoute", () => {
  it("is /operations/<name>/ for every operation of the catalogue", () => {
    expect(operationRoute("add_column")).toBe("/operations/add_column/");
    expect([...CALLABLE_OPERATIONS].sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
  });
});
