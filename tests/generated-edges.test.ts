import { describe, expect, it } from "vitest";
import { evalGenerated, GeneratedExpressionError, generatedRefs, isLinkExpression, isTemplateExpression } from "../src/core/generated";

/** Matches an error of the same class with the same message (toThrow alone compares messages only). */
const exactly = (e: Error) => expect.objectContaining({ constructor: e.constructor, message: e.message });

/** A row's column reader. */
const row = (values: Record<string, unknown>) => (column: string) => values[column];
const PATH = "Datanotes/main/public/log/2026/10/06/2026-10-06 walk.md";

describe("generatedRefs: the columns an expression reads", () => {
  it.each([
    ["title", ["title"]],
    [" path ", ["path"]],
    ["date(occurred_at) - 7", ["occurred_at"]],
    ["{name} {surname} ({name})", ["name", "surname"]],
    ["{min(occurred_at, created_at):YYYY-MM-DD} {kind}", ["occurred_at", "created_at", "kind"]],
    ["link({occurred_at:YYYY-MM-DD})", ["occurred_at"]],
  ])("%s reads %j", (expr, refs) => {
    expect(generatedRefs(expr)).toEqual(refs);
  });

  it("link() needs a name template with a {column}", () => {
    expect(() => generatedRefs("link(occurred_at)")).toThrow(
      exactly(new GeneratedExpressionError(`"link(occurred_at)": link() needs a name template with at least one {column}`)),
    );
  });

  it("tells a link expression from a template", () => {
    expect([isLinkExpression(" link({a}) "), isTemplateExpression(" link({a}) "), isTemplateExpression("{a}"), isTemplateExpression("a")]).toEqual([true, false, true, false]);
  });
});

describe("evalGenerated: plain columns and path", () => {
  it("a column name reads the value as it is, of any type", () => {
    expect(evalGenerated("title", row({ title: "Walk by the lake" }), PATH)).toBe("Walk by the lake");
    expect(evalGenerated(" people ", row({ people: ["[[Ada]]", "[[Ted]]"] }), PATH)).toEqual(["[[Ada]]", "[[Ted]]"]);
    expect(evalGenerated("metric_drinks", row({}), PATH)).toBeUndefined();
  });

  it("`path` is the row's path, as a whole expression and in a template", () => {
    expect(evalGenerated("path", row({ path: "ignored" }), PATH)).toBe(PATH);
    expect(evalGenerated("{kind} at {path}", row({ kind: "walk" }), PATH)).toBe(`walk at ${PATH}`);
  });
});

describe("evalGenerated: date(column) ± N", () => {
  it("shifts forward and back, across months and years, keeping only the day", () => {
    const r = row({ occurred_at: "2026-12-31T23:30:00+01:00" });
    expect([evalGenerated("date(occurred_at)", r, PATH), evalGenerated("date(occurred_at)+1", r, PATH), evalGenerated("date(occurred_at) - 31", r, PATH)]).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2026-11-30",
    ]);
  });

  it("shifts every item of a list, an item that is not a date becoming null", () => {
    expect(evalGenerated("date(reminders)-1", row({ reminders: ["2026-10-01T09:00", "soon", 7] }), PATH)).toEqual(["2026-09-30", null, null]);
  });

  it("a value that is not a date text is null", () => {
    expect([12, null, undefined, "next week", "06/10/2026"].map((v) => evalGenerated("date(when)", row({ when: v }), PATH))).toEqual([null, null, null, null, null]);
  });
});

describe("evalGenerated: templates", () => {
  it("formats dates with YYYY MM DD HH mm ss and [literal] text, a missing time being 00", () => {
    const r = row({ occurred_at: "2026-10-06T08:05", day: "2026-10-06", stamp: "2026-10-06T08:05:09+02:00" });
    expect(evalGenerated("{occurred_at:YYYY-MM-DD[T]HHmm}", r, PATH)).toBe("2026-10-06T0805");
    expect(evalGenerated("{day:DD/MM/YYYY [at] HH:mm}", r, PATH)).toBe("06/10/2026 at 00:00");
    expect(evalGenerated("{stamp:HH:mm:ss}", r, PATH)).toBe("08:05:09");
  });

  it("a format on a value that is not a date leaves the value as it is", () => {
    expect(evalGenerated("{name:YYYY-MM-DD}", row({ name: "Alice" }), PATH)).toBe("Alice");
    expect(evalGenerated("{n:DD/MM}", row({ n: 42 }), PATH)).toBe("42");
  });

  it("links render as their alias or their note name, nested lists flattened", () => {
    const r = row({ who: "[[People/Ada Lovelace]]", with: ["[[People/Ted.md]]", "[[People/Una|Una K.]]", ["[[Bo]]"]], where: "[[Places/Lake| the lake ]]" });
    expect(evalGenerated("{who} with {with} at {where}", r, PATH)).toBe("Ada Lovelace with Ted, Una K., Bo at the lake");
  });

  it("empty brackets and parentheses left by empty values go away", () => {
    expect(evalGenerated("{name} ({born:DD/MM}) [{tags}]", row({ name: "Ada", tags: [] }), PATH)).toBe("Ada");
    expect(evalGenerated("({a}) [{b}]", row({}), PATH)).toBeNull();
  });
});

describe("evalGenerated: link(…)", () => {
  const r = row({ occurred_at: "2026-10-06T08:05" });

  it("links into the folder of the ref table", () => {
    expect(evalGenerated("link({occurred_at:YYYY-MM-DD})", r, PATH, () => "Datanotes/main/journal/day")).toBe(
      "[[Datanotes/main/journal/day/2026-10-06|2026-10-06]]",
    );
  });

  it("an empty folder (a partitioned ref table) links by note name", () => {
    expect(evalGenerated("link({occurred_at:YYYY-MM-DD})", r, PATH, () => "")).toBe("[[2026-10-06|2026-10-06]]");
  });

  it("no link without a folder: the ref table is unknown, or none is given", () => {
    expect(evalGenerated("link({occurred_at:YYYY-MM-DD})", r, PATH, () => null)).toBeNull();
    expect(evalGenerated("link({occurred_at:YYYY-MM-DD})", r, PATH)).toBeNull();
  });

  it("no link when a placeholder is empty", () => {
    expect(evalGenerated("link({occurred_at:YYYY-MM-DD} {kind})", r, PATH, () => "D/day")).toBeNull();
  });
});
