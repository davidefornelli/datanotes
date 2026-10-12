/**
 * `npm run bench`: what automatic links cost a write on a vault of ~2000 notes (AUTOLINK_BENCH_NOTES),
 * on the headless Node host. It measures the first write (the index of note names is built), then
 * insert_row and update_row with a review that mentions a dozen notes, with automatic links on and
 * off, and the cost of the index after a hand edit (one file read again).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTable, INDEX_RETRY } from "../src/core/engine";
import { described } from "../tests/helpers/descriptions";
import { invalidateFiles } from "../src/core/file-cache";
import { insertRow, updateRow } from "../src/core/rows";
import { mergeWithDefaults } from "../src/core/settings";
import { openNodeVault } from "../src/node/node-app";

INDEX_RETRY.delayMs = 1;

const NOTES = Number(process.env.AUTOLINK_BENCH_NOTES ?? 2000);
const SAMPLES = Number(process.env.SAMPLES ?? 20);

const FIRST = ["Ada", "Alan", "Grace", "Edith", "Cary", "Audrey", "Ingrid", "James", "Katharine", "Rosalind", "Fred", "Ginger", "Orson", "Billy", "Marilyn", "Gene", "Doris", "Humphrey", "Lauren", "Bette", "Joan", "Clark", "Vivien", "Spencer", "Barbara", "Henry", "Gary", "Greta", "Marlene", "Charles", "Buster", "Harold", "Lillian", "Mary", "Douglas", "Claudette", "Myrna", "William", "Jean", "Errol", "Olivia", "Judy", "Mickey", "Shirley", "Tyrone", "Rita", "Gloria", "Montgomery", "Ava", "Burt"];
const LAST = ["Lovelace", "Turing", "Hopper", "Clarke", "Grant", "Hepburn", "Bergman", "Stewart", "Russell", "Astaire", "Rogers", "Welles", "Wilder", "Monroe", "Kelly", "Day", "Bogart", "Bacall", "Davis", "Crawford", "Gable", "Leigh", "Tracy", "Stanwyck", "Fonda", "Cooper", "Garbo", "Dietrich", "Chaplin", "Keaton", "Lloyd", "Gish", "Pickford", "Fairbanks", "Colbert", "Loy", "Powell", "Harlow", "Flynn", "Havilland"];

const ms = (t: bigint) => Number(t) / 1e6;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe(`automatic links on a vault of ${NOTES} notes`, () => {
  it("costs a write little once the index of names is built", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autolink-bench-"));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "autolink-bench-store-"));
    const names: string[] = [];
    for (let i = 0; names.length < NOTES; i++) names.push(`${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= FIRST.length * LAST.length ? ` ${Math.floor(i / (FIRST.length * LAST.length)) + 1}` : ""}`);
    for (const [i, name] of names.entries()) {
      const dir = path.join(root, "People", String(i % 20));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.md`), i % 10 === 0 ? `---\naliases: [${name.toUpperCase()}]\n---\nA person.\n` : "A person.\n");
    }
    const host = openNodeVault(root, undefined, { store });
    const app = host.app;
    const settings = mergeWithDefaults({ databaseFolder: "datanotes", fileLogEnabled: false });
    await createTable(app, settings, described({ name: "film", options: { filename: "{title}" }, columns: [{ name: "title", type: "string", required: true }] }));
    const mentioned = names.filter((_, i) => i % 167 === 0).slice(0, 12);
    const review = (n: number) =>
      `## Notes\n\nWatched it on night ${n}. ${mentioned.map((m, i) => (i % 3 === 0 ? `${m} was wonderful.` : `With ${m}, as always.`)).join(" ")}\n\n` +
      `${"The plot moves fast and the dialogue is sharp; nobody in the hall checked a phone. ".repeat(12)}\n\n\`\`\`\ncode ${mentioned[0]}\n\`\`\`\n`;

    const write = async (i: number, autolink: boolean) => {
      const t0 = process.hrtime.bigint();
      const r = await insertRow(app, settings, { table: "film", values: { title: `Film ${autolink ? "on" : "off"} ${i}` }, body: review(i), autolink });
      const took = ms(process.hrtime.bigint() - t0);
      expect(r.ok).toBe(true);
      if (autolink) expect(r.links_added?.length).toBe(mentioned.length);
      return took;
    };
    const first = await write(-1, true);
    const on: number[] = [];
    const off: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      off.push(await write(i, false));
      on.push(await write(i, true));
    }
    const updates: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = process.hrtime.bigint();
      await updateRow(app, settings, { table: "film", path: `datanotes/main/public/film/Film on ${i}.md`, bodyAppend: `Again with ${mentioned[1]} and ${names[NOTES - 1 - i]}.` });
      updates.push(ms(process.hrtime.bigint() - t0));
    }
    // a hand edit of one note: the index reads that file again, and only that one
    const hand = path.join(root, "People", "3", `${names[3]}.md`);
    fs.writeFileSync(hand, "---\naliases: [Somebody Else]\n---\n");
    host.vault.syncPath(`People/3/${names[3]}.md`);
    invalidateFiles(app, [`People/3/${names[3]}.md`]);
    const afterEdit = await write(SAMPLES, true);
    console.log(
      [
        `vault: ${NOTES} notes (${NOTES / 10} with aliases), a review of ${review(0).length} characters mentioning ${mentioned.length} of them`,
        `first write (index built): ${first.toFixed(1)} ms`,
        `insert_row, median of ${SAMPLES}: ${median(on).toFixed(1)} ms with automatic links, ${median(off).toFixed(1)} ms without`,
        `update_row body_append, median of ${SAMPLES}: ${median(updates).toFixed(1)} ms`,
        `insert_row after a hand edit of one note: ${afterEdit.toFixed(1)} ms`,
      ].join("\n"),
    );
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  });
});
