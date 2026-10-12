import { describe, expect, it } from "vitest";
import { describeTable } from "../src/core/public-api";
import { insertRow, updateRow } from "../src/core/rows";
import { alterColumn } from "../src/core/engine";
import { createDbVault, METASTORE, withTables } from "./helpers/db-vault";
import { described } from "./helpers/descriptions";

const YAML = withTables(`fact:
  options:
    filename: "{what}"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: what, type: string, required: true }
    - name: origin
      type: enum
      required: true
      values: [stated, estimated]
      value_descriptions:
        stated: the user said it
        estimated: a guess of the agent, not confirmed
`);

describe("enum value descriptions", () => {
  it("are part of the schema and come back in describe_table", async () => {
    const v = createDbVault({ [METASTORE]: YAML });
    const d = await describeTable(v.app, v.settings, "fact");
    const origin = (d.columns as { name: string; value_descriptions?: unknown }[]).find((c) => c.name === "origin");
    expect(origin?.value_descriptions).toEqual({ stated: "the user said it", estimated: "a guess of the agent, not confirmed" });
  });

  it("a missing or wrong value is refused with the allowed values and their meaning", async () => {
    const v = createDbVault({ [METASTORE]: YAML });
    const missing = await insertRow(v.app, v.settings, { table: "fact", values: { what: "x" } });
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(missing.violations)).toContain("is required: one of stated (the user said it); estimated (a guess of the agent, not confirmed)");
    const wrong = await insertRow(v.app, v.settings, { table: "fact", values: { what: "x", origin: "sure" } });
    expect(JSON.stringify(wrong.violations)).toContain("must be one of: stated (the user said it); estimated (a guess of the agent, not confirmed)");
    const ok = await insertRow(v.app, v.settings, { table: "fact", values: { what: "x", origin: "stated" } });
    expect(ok.ok).toBe(true);
    const path = ok.planned_creates![0]!;
    const unset = await updateRow(v.app, v.settings, { table: "fact", path, unset: ["origin"] });
    expect(JSON.stringify(unset.violations)).toContain("is required: one of stated");
  });

  it("must describe values of the column, and survive alter_column", async () => {
    const bad = createDbVault({ [METASTORE]: YAML.replace("estimated: a guess", "guessed: a guess") });
    await expect(describeTable(bad.app, bad.settings, "fact")).rejects.toThrow(/"guessed" is not one of the values/);
    const v = createDbVault({ [METASTORE]: YAML });
    const r = await alterColumn(v.app, v.settings, { table: "fact", name: "origin", changes: { label: "Source" } });
    expect(r.ok).toBe(true);
    expect(v.read(METASTORE)).toContain("value_descriptions");
    const d = await describeTable(v.app, v.settings, "fact");
    expect((d.columns as { name: string; value_descriptions?: Record<string, string> }[]).find((c) => c.name === "origin")?.value_descriptions?.stated).toBe("the user said it");
  });
});

describe("external_default", () => {
  it("fills a note made by hand in a table folder; tool writes still have to give the value", async () => {
    const { adoptCreatedNote } = await import("../src/core/auto-adopt");
    const { configureDatabase } = await import("../src/core/database");
    const { createTable } = await import("../src/core/engine");
    const { readOrderedFromMarkdown } = await import("../src/core/frontmatter");
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    await createTable(v.app, v.settings, described({
      schema: "journal", name: "day", options: { filename: "{date:YYYY-MM-DD}" },
      columns: [
        { name: "date", type: "date", required: true, unique: true },
        { name: "origin", type: "enum", required: true, values: ["stated", "estimated"], value_descriptions: { stated: "the user said it", estimated: "a guess" }, external_default: "stated" },
      ],
    }));
    const P = "Datanotes/main/journal/day/2026-09-30.md";
    expect(await adoptCreatedNote(v.app, v.settings, v.write(P, ""))).toEqual({ adopted: true, table: "main.journal.day" });
    expect(Object.fromEntries(readOrderedFromMarkdown(v.read(P)).ordered).origin).toBe("stated");
    const viaTool = await insertRow(v.app, v.settings, { table: "day", values: { date: "2026-10-01" } });
    expect(JSON.stringify(viaTool.violations)).toContain("is required: one of stated (the user said it); estimated (a guess)");
  });
});

describe("generated link(…)", () => {
  it("links each event to its day note, existing or not, and follows the day table's folder", async () => {
    const { configureDatabase } = await import("../src/core/database");
    const { createTable } = await import("../src/core/engine");
    const { readOrderedFromMarkdown } = await import("../src/core/frontmatter");
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    await createTable(v.app, v.settings, described({ schema: "journal", name: "day", options: { filename: "{date:YYYY-MM-DD}" }, columns: [{ name: "date", type: "date", required: true }] }));
    await createTable(v.app, v.settings, described({
      schema: "public", name: "log", options: { filename: "{occurred_at:YYYY-MM-DD[T]HHmm}" },
      columns: [
        { name: "occurred_at", type: "datetime", required: true },
        { name: "day", type: "link", ref: "main.journal.day", generated: "link({occurred_at:YYYY-MM-DD})" },
      ],
    }));
    const r = await insertRow(v.app, v.settings, { table: "log", values: { occurred_at: "2026-10-03T21:00" } });
    expect(r.ok).toBe(true);
    const fm = Object.fromEntries(readOrderedFromMarkdown(v.read(r.planned_creates![0]!)).ordered);
    expect(fm.day).toBe("[[Datanotes/main/journal/day/2026-10-03|2026-10-03]]");
    // the day note does not exist: the row is valid all the same
    expect(v.exists("Datanotes/main/journal/day/2026-10-03.md")).toBe(false);
    // a time column change moves the link
    const u = await updateRow(v.app, v.settings, { table: "log", path: r.planned_creates![0]!, set: { occurred_at: "2026-10-04T08:00" } });
    expect(u.ok).toBe(true);
  });

  it("must be a link column with ref", async () => {
    const { createTable } = await import("../src/core/engine");
    const v = createDbVault({});
    await expect(createTable(v.app, v.settings, described({ schema: "public", name: "x", options: { filename: "{a}" }, columns: [{ name: "a", type: "date" }, { name: "d", type: "string", generated: "link({a})" }] }))).rejects.toThrow(/link column with "ref"/);
  });
});

describe("generated columns read identity columns", () => {
  it("a link from the creation time is there on insert", async () => {
    const { configureDatabase } = await import("../src/core/database");
    const { createTable } = await import("../src/core/engine");
    const { readOrderedFromMarkdown } = await import("../src/core/frontmatter");
    const v = createDbVault({});
    await configureDatabase(v.app, v.settings, { timezone: "Europe/Rome" }, async () => {});
    await createTable(v.app, v.settings, described({ schema: "journal", name: "day", options: { filename: "{date:YYYY-MM-DD}" }, columns: [{ name: "date", type: "date", required: true }] }));
    await createTable(v.app, v.settings, described({
      schema: "public", name: "person", options: { filename: "{name}" },
      columns: [
        { name: "name", type: "string", required: true },
        { name: "created_at", type: "datetime", identity: "created" },
        { name: "day_note", type: "link", ref: "main.journal.day", required: true, generated: "link({created_at:YYYY-MM-DD})" },
      ],
    }));
    const r = await insertRow(v.app, v.settings, { table: "person", values: { name: "Carol" } });
    expect(r.ok).toBe(true);
    const fm = Object.fromEntries(readOrderedFromMarkdown(v.read(r.planned_creates![0]!)).ordered);
    expect(String(fm.day_note)).toMatch(/^\[\[Datanotes\/main\/journal\/day\/\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}\]\]$/);
    expect(String(fm.day_note)).toContain(String(fm.created_at).slice(0, 10));
  });
});

describe("min / max / coalesce in templates", () => {
  it("the event's day, never later than the day the row was written", async () => {
    const { evalGenerated, generatedRefs } = await import("../src/core/generated");
    const row = (v: Record<string, unknown>) => (k: string) => v[k];
    const expr = "link({min(occurred_at, created_at):YYYY-MM-DD})";
    expect(generatedRefs(expr)).toEqual(["occurred_at", "created_at"]);
    const folder = () => "D/day";
    // a note about yesterday, written today → yesterday
    expect(evalGenerated(expr, row({ occurred_at: "2026-10-04T21:00:00+02:00", created_at: "2026-10-05T10:00:00+02:00" }), "x", folder)).toBe("[[D/day/2026-10-04|2026-10-04]]");
    // something in the future, written today → today
    expect(evalGenerated(expr, row({ occurred_at: "2026-10-20T09:00:00+02:00", created_at: "2026-10-05T10:00:00+02:00" }), "x", folder)).toBe("[[D/day/2026-10-05|2026-10-05]]");
    // no event day → the day it was written
    expect(evalGenerated(expr, row({ created_at: "2026-10-05T10:00:00+02:00" }), "x", folder)).toBe("[[D/day/2026-10-05|2026-10-05]]");
    expect(evalGenerated(expr, row({}), "x", folder)).toBeNull();
    expect(evalGenerated("{max(a, b)}", row({ a: "2026-01-01", b: "2026-02-01" }), "x")).toBe("2026-02-01");
    expect(evalGenerated("{coalesce(a, b)}", row({ b: "B" }), "x")).toBe("B");
  });
});
