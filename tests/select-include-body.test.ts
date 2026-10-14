/**
 * include_body reads each row's properties and body from one version of its note: a note deleted
 * after the scan is left out of the page (the others keep their bodies, `total` keeps the scan's
 * count), a note edited after the scan gives both from its new text, a read that fails while the
 * note is still there fails the select, and rows of the past keep the body they carry.
 */

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { invalidateFiles, TEXT_CACHE } from "../src/core/file-cache";
import type { TFile } from "../src/core/host";
import { INDEX_RETRY } from "../src/core/engine";
import { select } from "../src/core/rows";
import { logVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const budget = { ...TEXT_CACHE };
afterEach(() => void Object.assign(TEXT_CACHE, budget));

/** A log vault whose texts are not kept: a body is read from the note; `onRead` runs before each read of a note. */
async function vault(onRead: (path: string) => void) {
  const v = logVault();
  TEXT_CACHE.maxChars = 0;
  invalidateFiles(v.app, ["Daily/a.md", "Daily/b.md"]);
  expect((await select(v.app, v.settings, { table: "log" })).total).toBe(2); // the parses, no text
  const vault = v.app.vault as unknown as { read(f: TFile): Promise<string> };
  const real = vault.read.bind(vault);
  vault.read = async (f) => {
    onRead(f.path);
    return real(f);
  };
  return v;
}

describe("select with include_body", () => {
  it("leaves out a note deleted by hand after the scan; the others keep their bodies", async () => {
    let done = false;
    const v = await vault((p) => {
      if (p === "Daily/b.md" && !done) {
        done = true;
        fs.rmSync(v.abs(p));
      }
    });
    const r = await select(v.app, v.settings, { table: "log", columns: ["kind"], includeBody: true });
    expect(r.total).toBe(2);
    expect(r.rows).toEqual([{ path: "Daily/a.md", kind: "alcohol", body: "A\n" }]);
  });

  it("gives a note edited after the scan its properties and its body from its new text", async () => {
    let done = false;
    const v = await vault((p) => {
      if (p === "Daily/b.md" && !done) {
        done = true;
        fs.writeFileSync(v.abs(p), "---\ntable: main.public.log\nid: 01a0f000-0000-7000-8000-00000000000b\nkind: walk\noccurred_at: 2026-09-26T08:00\n---\nB again\n");
      }
    });
    const r = await select(v.app, v.settings, { table: "log", where: { path: "Daily/b.md" }, columns: ["kind"], includeBody: true });
    expect(r.rows).toEqual([{ path: "Daily/b.md", kind: "walk", body: "B again\n" }]);
  });

  it("fails when a read fails while the note is still there", async () => {
    const v = await vault((p) => {
      if (p === "Daily/b.md") throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });
    await expect(select(v.app, v.settings, { table: "log", includeBody: true })).rejects.toThrow("EBUSY");
  });

  it("keeps the body a row of the past carries", async () => {
    const v = logVault();
    const r = await select(v.app, v.settings, { table: "system.information_schema.tables", columns: ["table_name"], includeBody: true });
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.body).toBe("");
  });

  it("gives no row a body without include_body", async () => {
    const v = logVault();
    const r = await select(v.app, v.settings, { table: "log", columns: ["kind"] });
    expect(r.rows.length).toBe(2);
    for (const row of r.rows) expect(row).not.toHaveProperty("body");
  });
});
