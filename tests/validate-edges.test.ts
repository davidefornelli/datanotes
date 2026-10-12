import { describe, expect, it } from "vitest";
import type { ColumnSpec } from "../src/core/types-table";
import { validateValue, type ValidationContext } from "../src/core/validate";

function col(partial: Partial<ColumnSpec> & Pick<ColumnSpec, "name" | "type">): ColumnSpec {
  return { required: false, aliases: [], ...partial };
}

/** A vault with two mood tables (in different catalogs) and a table whose name ends like it. */
const OWNERS: Record<string, string> = {
  "Datanotes/personal/metrics/mood/Calm.md": "personal.metrics.mood",
  "Datanotes/work/metrics/mood/Busy.md": "work.metrics.mood",
  "Datanotes/personal/metrics/badmood/Grumpy.md": "personal.metrics.badmood",
};
const ctx: ValidationContext = {
  resolveLink: (p) => Object.keys(OWNERS).find((path) => path.endsWith(`/${p}.md`)) ?? null,
  tableOfPath: (p) => OWNERS[p] ?? null,
};
const refViolation = (ref: string, value: string) => [
  { column: "feeling", code: "ref", message: `link must point to a row of table "${ref}"`, value },
];

describe("link columns: which table a `ref` accepts", () => {
  it("a full catalog.schema.table ref accepts only rows of that very table", () => {
    const spec = col({ name: "feeling", type: "link", ref: "personal.metrics.mood" });
    expect(validateValue(spec, "[[Calm]]", ctx)).toEqual([]);
    expect(validateValue(spec, "[[Busy]]", ctx)).toEqual(refViolation("personal.metrics.mood", "[[Busy]]"));
  });

  it("a short ref (older metastores) matches the table name in any catalog or schema", () => {
    const bare = col({ name: "feeling", type: "link", ref: "mood" });
    expect(validateValue(bare, "[[Calm]]", ctx)).toEqual([]);
    expect(validateValue(bare, "[[Busy]]", ctx)).toEqual([]);
    const schemaQualified = col({ name: "feeling", type: "link", ref: "metrics.mood" });
    expect(validateValue(schemaQualified, "[[Busy]]", ctx)).toEqual([]);
  });

  it("a short ref matches whole names only: `mood` does not accept a row of `badmood`", () => {
    const spec = col({ name: "feeling", type: "link", ref: "mood" });
    expect(validateValue(spec, "[[Grumpy]]", ctx)).toEqual(refViolation("mood", "[[Grumpy]]"));
  });

  it("a link to a note that is no row of any table is refused for a column with ref", () => {
    const spec = col({ name: "feeling", type: "link", ref: "mood" });
    const plain: ValidationContext = { resolveLink: () => "Notes/Plain.md", tableOfPath: () => null };
    expect(validateValue(spec, "[[Plain]]", plain)).toEqual(refViolation("mood", "[[Plain]]"));
  });
});
