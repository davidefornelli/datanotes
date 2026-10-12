/**
 * auto-adopt: a note whose adoption is refused is left exactly as it was made (the row template it
 * was given for the adoption is taken back).
 */

import { describe, expect, it } from "vitest";
import { adoptCreatedNote } from "../src/core/auto-adopt";
import { INDEX_RETRY } from "../src/core/engine";
import { createDbVault, METASTORE, withTables } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const TABLES = `diary:
  options: { filename: "{day:YYYY-MM-DD}" }
  row_template: "## Notes\\n"
  columns:
    - { name: id, type: string, unique: true, identity: uuid, required: true, dense: true }
    - { name: day, type: date, required: true, dense: true }
`;
const D = "Datanotes/main/public/diary";

describe("a refused adoption", () => {
  it("leaves the note as it was, empty or with properties only", async () => {
    for (const text of ["", "---\nmood: ok\n---\n"]) {
      const v = createDbVault({ [METASTORE]: withTables(TABLES) });
      const f = v.write(`${D}/notes.md`, text);
      const r = await adoptCreatedNote(v.app, v.settings, f);
      expect([r.adopted, r.reason]).toEqual([false, expect.stringMatching(/day/)]);
      expect(v.read(`${D}/notes.md`)).toBe(text);
    }
  });

  it("an adopted note keeps the row template", async () => {
    const v = createDbVault({ [METASTORE]: withTables(TABLES) });
    const f = v.write(`${D}/2026-09-30.md`, "");
    expect((await adoptCreatedNote(v.app, v.settings, f)).adopted).toBe(true);
    expect(v.read(`${D}/2026-09-30.md`)).toMatch(/\n## Notes\n$/);
  });
});
