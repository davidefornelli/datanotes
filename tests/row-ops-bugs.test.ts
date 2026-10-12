/**
 * merge_rows: a malformed `on` or `rows` gets its refusal (the telemetry reads the input only after
 * it), and inserted rows get the row template with its placeholders filled, as insert_row does.
 */

import { describe, expect, it } from "vitest";
import { INDEX_RETRY, OperationInputError } from "../src/core/engine";
import { readOrderedFromMarkdown } from "../src/core/frontmatter";
import { insertRow, mergeRows } from "../src/core/rows";
import { createDbVault, logVault, METASTORE, withTables } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

async function refused(p: Promise<unknown>, message: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(OperationInputError);
  await expect(p).rejects.toThrow(message);
}

describe("merge_rows input", () => {
  it("refuses a missing or malformed on / rows with its message", async () => {
    const v = logVault();
    await refused(mergeRows(v.app, v.settings, { table: "log", rows: [{ kind: "walk" }] } as never), `"on" needs at least one key column`);
    await refused(mergeRows(v.app, v.settings, { table: "log", on: "kind", rows: [{ kind: "walk" }] } as never), `"on" needs at least one key column`);
    await refused(mergeRows(v.app, v.settings, { table: "log", on: ["kind"] } as never), `"rows" needs at least one row`);
  });
});

describe("merge_rows inserts", () => {
  it("fill the row template's placeholders, as insert_row does", async () => {
    const v = createDbVault({
      [METASTORE]: withTables(`book:
  options: { filename: "{title}" }
  row_template: "# {title}\\n\\nBy {author}. {missing}\\n"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: title, type: string }
    - { name: author, type: string }
`),
    });
    const D = "Datanotes/main/public/book";
    expect((await insertRow(v.app, v.settings, { table: "book", values: { title: "Emma", author: "Austen" } })).ok).toBe(true);
    const r = await mergeRows(v.app, v.settings, { table: "book", on: ["title"], rows: [{ title: "Dune", author: "Herbert" }] });
    expect(r.ok, JSON.stringify([r.conflicts, r.violations])).toBe(true);
    expect(readOrderedFromMarkdown(v.read(`${D}/Emma.md`)).body).toBe("# Emma\n\nBy Austen. {missing}\n");
    expect(readOrderedFromMarkdown(v.read(`${D}/Dune.md`)).body).toBe("# Dune\n\nBy Herbert. {missing}\n");
  });
});
