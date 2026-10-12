/**
 * Automatic links (src/core/autolink.ts): the text a write puts in a body links the notes it
 * mentions; doubtful mentions come back in `ambiguous_mentions` with their candidates. On both hosts
 * (`npm test` and `npm run test:node`).
 */

import { describe, expect, it } from "vitest";
import { autolinkFragments, linkedTargets, nameKey } from "../src/core/autolink";
import { configureDatabase } from "../src/core/database";
import { createTable, INDEX_RETRY, undoOperation } from "../src/core/engine";
import { bumpVaultGeneration } from "../src/core/file-cache";
import type { App } from "../src/core/host";
import { alterTable, deleteRows, insertRow, updateRow, updateRows } from "../src/core/rows";
import { createPublicApi } from "../src/core/public-api";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { createHandlers, dispatch } from "../src/server/rest";
import { OPERATIONS } from "../src/api/catalog";
import { operationRequest } from "../src/api/requests";
import { createDbVault, LOG_DIR, METASTORE, withTables, type DbVault } from "./helpers/db-vault";
import { validate } from "./helpers/schema";
import { described } from "./helpers/descriptions";

const responseSchema = (op: string) => OPERATIONS.find((o) => o.name === op)!.responseSchema!;

INDEX_RETRY.delayMs = 1;

const FILM = "Datanotes/main/public/film";
const ACTOR = "Datanotes/main/public/actor";
const film = (title: string) => `${FILM}/${title}.md`;
const actor = (name: string) => `${ACTOR}/${name}.md`;

/** A vault with actors (rows), plain notes and a film table to write reviews in. */
async function vault(files: Record<string, string> = {}): Promise<DbVault> {
  const v = createDbVault({ "Welcome.md": "# Welcome\n", ...files });
  await createTable(v.app, v.settings, described({ name: "actor", options: { filename: "{name}" }, columns: [{ name: "name", type: "string", required: true }] }));
  await createTable(v.app, v.settings, described({
    name: "film",
    options: { filename: "{title}" },
    columns: [
      { name: "title", type: "string", required: true },
      { name: "year", type: "integer" },
    ],
  }));
  for (const name of ["Cary Grant", "Audrey Hepburn"]) await insertRow(v.app, v.settings, { table: "actor", values: { name } });
  return v;
}

/** The body of a note (after its front matter). */
const bodyOf = (v: DbVault, path: string) => v.read(path).replace(/^---\n[\s\S]*?\n---\n/, "");

describe("nameKey", () => {
  it("keeps names of three characters or more, with a letter, that are not dates, ids or common words", () => {
    expect(nameKey("Cary  Grant")).toBe("cary grant");
    expect(nameKey("Sherlock Jr.")).toBe("sherlock jr");
    expect(nameKey("Ada")).toBe("ada");
    expect(nameKey("Al")).toBeNull();
    expect(nameKey("1984")).toBeNull();
    for (const date of ["2026-09-27", "2026-09-27T0900", "2026-09-27 14:30", "2026-W40", "2026-Q3", "2026-09-27-2"]) expect(nameKey(date), date).toBeNull();
    expect(nameKey("01a124fc-e608-7388-8c0c-7ae954c6603b")).toBeNull();
    expect(nameKey("Welcome")).toBeNull();
    expect(nameKey("The")).toBeNull();
    expect(nameKey("questo")).toBeNull();
    expect(nameKey("A [draft]")).toBeNull();
    expect(nameKey("Zoë")).toBe("zoë");
    // more words than a mention is ever made of
    expect(nameKey("one two three four five six seven eight nine ten eleven twelve")).not.toBeNull();
    expect(nameKey("one two three four five six seven eight nine ten eleven twelve thirteen")).toBeNull();
  });
});

describe("the index of names", () => {
  it("works on a host without file stats and a vault without a database, reading the names again after a change", async () => {
    const names = ["People/Cary Grant.md", "People/Cary Elwes.md", "Notes/Review.md"];
    const tf = (p: string) => ({ path: p, name: p.split("/").pop()!, basename: p.split("/").pop()!.replace(/\.md$/, ""), extension: "md" });
    const app = {
      vault: { getMarkdownFiles: () => names.map(tf), getAbstractFileByPath: (p: string) => (names.includes(p) ? tf(p) : null) },
      metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
    } as unknown as App;
    const write = (text: string) => autolinkFragments(app, DEFAULT_SETTINGS, { path: "Notes/Review.md", fragments: [text], body: text });
    expect((await write("Cary Grant.")).fragments).toEqual(["[[Cary Grant]]."]);
    names.splice(0, 1);
    expect((await write("Cary Grant, Cary Elwes.")).fragments).toEqual(["[[Cary Grant]], [[Cary Elwes]]."]); // nothing changed for the index yet
    bumpVaultGeneration(app);
    expect((await write("Cary Grant, Cary Elwes.")).fragments).toEqual(["Cary Grant, [[Cary Elwes]]."]);
  });

  it("leaves out the archive folders of the tables that load, and a table that does not load", async () => {
    const v = createDbVault({
      [METASTORE]: withTables("broken:\n  columns:\n    - { name: x, type: nope }\n"),
      "People/Cary Grant.md": "x\n",
      [`${LOG_DIR}/_archive/Old Friend.md`]: "x\n",
    });
    const text = "Cary Grant and Old Friend.";
    const r = await autolinkFragments(v.app, v.settings, { path: "Notes/Review.md", fragments: [text], body: text });
    expect(r.fragments).toEqual(["[[Cary Grant]] and Old Friend."]);
  });

  it("follows the autolink_target of a table that does not load: false leaves its rows out, true keeps them", async () => {
    const broken = (name: string, target: boolean) => `${name}:\n  options: { autolink_target: ${target} }\n  columns:\n    - { name: x, type: nope }\n`;
    const row = (table: string) => `---\ntable: main.public.${table}\n---\nx\n`;
    const v = createDbVault({
      [METASTORE]: withTables(broken("secret", false) + broken("trip", true)),
      "Notes/Secret Plan.md": row("secret"),
      "Notes/Grand Tour.md": row("trip"),
    });
    const text = "About Secret Plan and Grand Tour";
    const r = await autolinkFragments(v.app, v.settings, { path: "Notes/Review.md", fragments: [text], body: text });
    // the mention at the very end of the text stands alone too
    expect(r.fragments).toEqual(["About Secret Plan and [[Grand Tour]]"]);
  });

  it("writes nothing for empty text", async () => {
    const v = await vault();
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "" });
    expect(r.links_added).toBeUndefined();
    expect(bodyOf(v, film("Charade"))).toBe("");
  });
});

describe("automatic links", () => {
  it("links the notes a new row's body mentions, once each, and says what it linked", async () => {
    const v = await vault({ "Places/Paris.md": "A city.\n" });
    const r = await insertRow(v.app, v.settings, {
      table: "film",
      values: { title: "Charade", year: 1963 },
      body: "Cary Grant and Audrey Hepburn in Paris. Cary Grant is at his best.\n",
    });
    expect(r.ok).toBe(true);
    expect(bodyOf(v, film("Charade"))).toBe("[[Cary Grant]] and [[Audrey Hepburn]] in [[Paris]]. Cary Grant is at his best.\n");
    expect(r.links_added).toEqual([
      { path: film("Charade"), text: "Cary Grant", target: actor("Cary Grant"), link: "[[Cary Grant]]" },
      { path: film("Charade"), text: "Audrey Hepburn", target: actor("Audrey Hepburn"), link: "[[Audrey Hepburn]]" },
      { path: film("Charade"), text: "Paris", target: "Places/Paris.md", link: "[[Paris]]" },
    ]);
    expect(r.ambiguous_mentions).toBeUndefined();
  });

  it("matches names case-insensitively and keeps the text as written; aliases name a note too", async () => {
    const v = await vault({
      "People/Archibald Leach.md": "---\naliases: [Archie Leach]\n---\nBorn in Bristol.\n",
      "People/James Stewart.md": "---\nalias: Jimmy Stewart\n---\n",
      "People/Nobody Special.md": "---\naliases:\n---\n",
    });
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Notorious" }, body: "cary grant, born Archie Leach; not Jimmy Stewart.\n" });
    expect(bodyOf(v, film("Notorious"))).toBe("[[Cary Grant|cary grant]], born [[Archibald Leach|Archie Leach]]; not [[James Stewart|Jimmy Stewart]].\n");
    expect(r.links_added?.map((l) => l.target)).toEqual([actor("Cary Grant"), "People/Archibald Leach.md", "People/James Stewart.md"]);
  });

  it("reads a one-word name in lowercase as an ordinary word", async () => {
    const v = await vault({ "People/Will.md": "A friend.\n" });
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "I will watch it again, and Will liked it.\n" });
    expect(bodyOf(v, film("Charade"))).toBe("I will watch it again, and [[Will]] liked it.\n");
  });

  it("lets the longest name win", async () => {
    const v = await vault({ "People/Nora.md": "x\n", "People/Wells.md": "x\n", "People/Nora Wells.md": "x\n" });
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "Seen with Nora Wells.\n" });
    expect(bodyOf(v, film("Charade"))).toBe("Seen with [[Nora Wells]].\n");
    expect(r.ambiguous_mentions).toBeUndefined();
  });

  it("asks about two notes' names side by side, and leaves every mention of them as text", async () => {
    const v = await vault({ "People/Nora.md": "x\n", "People/Wells.md": "x\n" });
    const body = "Lunch with Nora Wells about the film.\n\nNora liked the ending.\n";
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body });
    expect(bodyOf(v, film("Charade"))).toBe(body);
    expect(r.links_added).toBeUndefined();
    expect(r.ambiguous_mentions).toEqual([
      {
        path: film("Charade"),
        text: "Nora Wells",
        reason: "adjacent",
        candidates: ["People/Nora.md", "People/Wells.md"],
        context: "Lunch with Nora Wells about the film.",
        hint: expect.stringContaining("read the notes and the text around it"),
      },
    ]);
  });

  it("asks about a name several notes have, overlapping names and a name inside a longer one", async () => {
    const v = await vault({
      "Places/Paris.md": "x\n",
      "People/Paris.md": "x\n",
      "Places/New York.md": "x\n",
      "Places/York City.md": "x\n",
      "Places/Philadelphia.md": "x\n",
    });
    const body = "From Paris to New York City.\n\nThen we watched The Philadelphia Story in Paris.\n";
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body });
    expect(bodyOf(v, film("Charade"))).toBe(body);
    expect(r.ambiguous_mentions?.map(({ text, reason, candidates }) => ({ text, reason, candidates }))).toEqual([
      { text: "Paris", reason: "same_name", candidates: ["People/Paris.md", "Places/Paris.md"] },
      { text: "New York City", reason: "overlap", candidates: ["Places/New York.md", "Places/York City.md"] },
      { text: "Philadelphia", reason: "part_of_name", candidates: ["Places/Philadelphia.md"] },
    ]);
    expect(r.ambiguous_mentions?.map((a) => a.hint)).toEqual([
      expect.stringMatching(/^Several notes are named "Paris": read them with read_note/),
      expect.stringMatching(/^The names of these notes overlap in "New York City"/),
      expect.stringMatching(/^"Philadelphia" may be part of a longer name/),
    ]);
  });

  it("quotes a long line around the mention", async () => {
    const v = await vault({ "People/Nora.md": "x\n", "People/Wells.md": "x\n" });
    const line = `${"Long before the screening we talked about films. ".repeat(3)}Then Nora Wells arrived. ${"After that we talked about films again. ".repeat(3)}`;
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: line.trim() });
    const context = r.ambiguous_mentions![0]!.context;
    expect(context.startsWith("…") && context.endsWith("…")).toBe(true);
    expect(context).toContain("Then Nora Wells arrived.");
    expect(context.length).toBeLessThan(170);
    // at the start or the end of the line, only the other side is cut
    const talk = "We talked about films for a long time. ".repeat(5).trim();
    const first = await insertRow(v.app, v.settings, { table: "film", values: { title: "Notorious" }, body: `Nora Wells arrived. ${talk}\n` });
    expect(first.ambiguous_mentions![0]!.context).toMatch(/^Nora Wells arrived\. We talked.*…$/);
    const last = await insertRow(v.app, v.settings, { table: "film", values: { title: "Vertigo" }, body: `${talk} Then came Nora Wells\n` });
    expect(last.ambiguous_mentions![0]!.context).toMatch(/^….*Then came Nora Wells$/);
  });

  it("never links a note to itself, nor anything inside its own name", async () => {
    const v = await vault({ "Places/New York.md": "---\naliases: [York City]\n---\n" });
    const r = await updateRow(v.app, v.settings, { table: "actor", path: actor("Cary Grant"), body: "Cary Grant, with Audrey Hepburn.\n" });
    expect(bodyOf(v, actor("Cary Grant"))).toBe("Cary Grant, with [[Audrey Hepburn]].\n");
    expect(r.links_added?.map((l) => l.text)).toEqual(["Audrey Hepburn"]);
    // its two names overlap: neither links, and nobody is asked
    const text = "Life in New York City.";
    const own = await autolinkFragments(v.app, v.settings, { path: "Places/New York.md", fragments: [text], body: text });
    expect(own).toEqual({ fragments: [text], report: { added: [], ambiguous: [] } });
  });

  it("does not take a capital at the start of a sentence or a list item for a longer name", async () => {
    const v = await vault();
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "- Starring Cary Grant.\n\nYes. Audrey Hepburn too.\n" });
    expect(bodyOf(v, film("Charade"))).toBe("- Starring [[Cary Grant]].\n\nYes. [[Audrey Hepburn]] too.\n");
  });

  it("skips code, links, URLs, tags, headings, comments and the notes the body links already", async () => {
    const v = await vault();
    const body = [
      "## Cary Grant",
      "",
      "Inline `Cary Grant` and [Audrey Hepburn](https://example.com/Audrey Hepburn).",
      "",
      "```",
      "Audrey Hepburn",
      "```",
      "",
      "See https://example.com/Cary%20Grant #CaryGrant <!-- Audrey Hepburn --> %%Audrey Hepburn%%",
      "",
      "[[Cary Grant]] is here already; Cary Grant again.",
      "",
    ].join("\n");
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body });
    expect(bodyOf(v, film("Charade"))).toBe(body);
    expect(r.links_added).toBeUndefined();
    // the front matter is never part of the text
    expect(v.read(film("Charade"))).toContain("\ntitle: Charade\n");
  });

  it("never links the note being written, nor a note in an archive folder", async () => {
    const v = await vault();
    const self = await insertRow(v.app, v.settings, { table: "actor", values: { name: "Grace Kelly" }, body: "Grace Kelly, later a princess.\n" });
    expect(self.links_added).toBeUndefined();
    expect(bodyOf(v, actor("Grace Kelly"))).toBe("Grace Kelly, later a princess.\n");
    expect((await deleteRows(v.app, v.settings, { table: "actor", where: { name: "Audrey Hepburn" } })).ok).toBe(true);
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "Audrey Hepburn and Grace Kelly.\n" });
    expect(bodyOf(v, film("Charade"))).toBe("Audrey Hepburn and [[Grace Kelly]].\n");
  });

  it("escapes the alias bar in a table row", async () => {
    const v = await vault();
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "| Role | Actor |\n| --- | --- |\n| Peter | cary grant |\n" });
    expect(bodyOf(v, film("Charade"))).toBe("| Role | Actor |\n| --- | --- |\n| Peter | [[Cary Grant\\|cary grant]] |\n");
  });

  it("learns new, renamed and removed notes between writes", async () => {
    const v = await vault();
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "Grace Kelly is not in it.\n" });
    expect(bodyOf(v, film("Charade"))).toBe("Grace Kelly is not in it.\n");
    await insertRow(v.app, v.settings, { table: "actor", values: { name: "Grace Kelly" } });
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Rear Window" }, body: "Grace Kelly is.\n" });
    expect(bodyOf(v, film("Rear Window"))).toBe("[[Grace Kelly]] is.\n");
    v.write("People/James Stewart.md", "---\naliases: [Jimmy Stewart]\n---\n");
    await v.rename(actor("Grace Kelly"), "People/Princess Grace.md");
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Vertigo" }, body: "Jimmy Stewart, without Grace Kelly.\n" });
    expect(bodyOf(v, film("Vertigo"))).toBe("[[James Stewart|Jimmy Stewart]], without Grace Kelly.\n");
    v.remove("People/James Stewart.md");
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Rope" }, body: "Jimmy Stewart again.\n" });
    expect(bodyOf(v, film("Rope"))).toBe("Jimmy Stewart again.\n");
  });

  it("links only the text update_row writes, and not a note the body links already", async () => {
    const v = await vault();
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "## Cast\n\nCary Grant.\n\n## Notes\n\nTo see.\n", autolink: false });
    const r = await updateRow(v.app, v.settings, {
      table: "film",
      path: film("Charade"),
      bodySections: { Notes: "Audrey Hepburn and Cary Grant, at last." },
      bodyAppend: "Audrey Hepburn again.",
      bodyPrepend: "A thriller with Cary Grant.",
    });
    expect(r.ok).toBe(true);
    expect(r.op).toBe("update_row");
    expect(bodyOf(v, film("Charade"))).toBe(
      "A thriller with [[Cary Grant]].\n\n## Cast\n\nCary Grant.\n\n## Notes\n\n[[Audrey Hepburn]] and Cary Grant, at last.\n\nAudrey Hepburn again.\n",
    );
    expect(r.links_added?.map((l) => l.text)).toEqual(["Cary Grant", "Audrey Hepburn"]);
    const again = await updateRow(v.app, v.settings, { table: "film", path: film("Charade"), bodyAppend: "Cary Grant, once more." });
    expect(again.links_added).toBeUndefined();
    expect(bodyOf(v, film("Charade")).endsWith("Audrey Hepburn again.\n\nCary Grant, once more.\n")).toBe(true);
  });

  it("links a whole body given to update_row", async () => {
    const v = await vault();
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" } });
    const one = await updateRow(v.app, v.settings, { table: "film", path: film("Charade"), body: "With Audrey Hepburn.\n" });
    expect(one.links_added?.map((l) => l.target)).toEqual([actor("Audrey Hepburn")]);
    const many = await updateRow(v.app, v.settings, { table: "film", path: film("Charade"), body: "With Cary Grant.\n" });
    expect(many.ok).toBe(true);
    expect(many.links_added?.map((l) => l.target)).toEqual([actor("Cary Grant")]);
    expect(bodyOf(v, film("Charade"))).toBe("With [[Cary Grant]].\n");
  });

  it("is off for one write with autolink: false, and for the database with the setting", async () => {
    const v = await vault();
    const off = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "Cary Grant.\n", autolink: false });
    expect(off.links_added).toBeUndefined();
    expect(bodyOf(v, film("Charade"))).toBe("Cary Grant.\n");
    const db = await configureDatabase(v.app, v.settings, { autolink: false }, async () => {});
    expect(db.config.autolink).toBe(false);
    expect(v.read("Datanotes/metastore.yaml")).toContain("\n  autolink: false\n");
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Notorious" }, body: "Cary Grant.\n" });
    expect(bodyOf(v, film("Notorious"))).toBe("Cary Grant.\n");
    // a write may still ask for it
    await updateRow(v.app, v.settings, { table: "film", path: film("Notorious"), body: "Cary Grant.\n", autolink: true });
    expect(bodyOf(v, film("Notorious"))).toBe("[[Cary Grant]].\n");
  });

  it("shows on a dry run what it would link, and undo takes the links back with the write", async () => {
    const v = await vault();
    const dry = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "Cary Grant.\n" }, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, dry_run: true, links_added: [{ text: "Cary Grant", target: actor("Cary Grant") }] });
    expect(v.exists(film("Charade"))).toBe(false);
    const ins = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "To see.\n" });
    const before = v.read(film("Charade"));
    const upd = await updateRow(v.app, v.settings, { table: "film", path: film("Charade"), bodyAppend: "With Audrey Hepburn." });
    expect(bodyOf(v, film("Charade"))).toBe("To see.\n\nWith [[Audrey Hepburn]].\n");
    expect((await undoOperation(v.app, v.settings, upd.migration_id!)).ok).toBe(true);
    expect(v.read(film("Charade"))).toBe(before);
    expect((await undoOperation(v.app, v.settings, ins.migration_id!)).ok).toBe(true);
    expect(v.exists(film("Charade"))).toBe(false);
  });

  it("reports nothing on a refused write", async () => {
    const v = await vault();
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade", year: "soon" }, body: "Cary Grant.\n" });
    expect(r.ok).toBe(false);
    expect(r.links_added).toBeUndefined();
  });

  it("finds the notes a text links already, wikilinks and Markdown links", async () => {
    const v = await vault();
    const found = linkedTargets(v.app, "[[Cary Grant|Cary]] and [Audrey](Datanotes/main/public/actor/Audrey%20Hepburn.md) and [[Nobody]] and [[]] and [bad](bad%E0%A4%A.md)", film("Charade"));
    expect([...found].sort()).toEqual([actor("Audrey Hepburn"), actor("Cary Grant")]);
  });
});

describe("automatic links in a real vault: safe by default", () => {
  const TASK = "Datanotes/main/public/task";

  it("never links the rows of a table that is no link target; a person note still is", async () => {
    const v = await vault({ "People/Oscar.md": "A friend.\n" });
    const task = described({ name: "task", options: { filename: "{title}", autolink_target: false }, columns: [{ name: "title", type: "string", required: true }] });
    expect((await createTable(v.app, v.settings, task)).ok).toBe(true);
    expect(v.read(METASTORE)).toMatch(/task:[\s\S]*options:[\s\S]*autolink_target: false/);
    await insertRow(v.app, v.settings, { table: "task", values: { title: "Call Oscar" } });
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "After the film I must call Oscar.\n" });
    expect(bodyOf(v, film("Charade"))).toBe("After the film I must call [[Oscar]].\n");
    expect(r.links_added?.map((l) => l.target)).toEqual(["People/Oscar.md"]);
    // a target again: the longest name wins, and the old task captures the mention
    expect((await alterTable(v.app, v.settings, { table: "task", autolinkTarget: true })).ok).toBe(true);
    const again = await insertRow(v.app, v.settings, { table: "film", values: { title: "Notorious" }, body: "After the film I must call Oscar.\n" });
    expect(again.links_added?.map((l) => l.target)).toEqual([`${TASK}/Call Oscar.md`]);
    // back to the default: a table named by text is a target
    expect((await alterTable(v.app, v.settings, { table: "task", autolinkTarget: null })).ok).toBe(true);
    expect(v.read(METASTORE)).not.toContain("autolink_target");
  });

  it("leaves out the rows of a table named by a date or a time, unless it says otherwise", async () => {
    const v = await vault({ "Food/Pizza margherita.md": "x\n" });
    await createTable(v.app, v.settings, described({
      name: "meal",
      timeColumn: "eaten_at",
      columns: [
        { name: "eaten_at", type: "datetime", required: true },
        { name: "aliases", type: "list", items: "string" },
      ],
    }));
    await insertRow(v.app, v.settings, { table: "meal", values: { eaten_at: "2026-10-09T20:00", aliases: ["Dinner with Leo"] } });
    const text = "Dinner with Leo: pizza margherita, then Pizza.\n";
    const r = await autolinkFragments(v.app, v.settings, { path: "Notes/Diary.md", fragments: [text], body: text });
    // a lowercase multi-word name matches the whole phrase only
    expect(r.fragments).toEqual(["Dinner with Leo: [[Pizza margherita|pizza margherita]], then Pizza.\n"]);
    expect((await alterTable(v.app, v.settings, { table: "meal", autolinkTarget: true })).ok).toBe(true);
    const linked = await autolinkFragments(v.app, v.settings, { path: "Notes/Diary.md", fragments: [text], body: text });
    expect(linked.report.added.map((l) => l.text)).toEqual(["Dinner with Leo", "pizza margherita"]);
  });

  it("refuses an autolink_target that is not true or false, saying where to read about it", async () => {
    const v = await vault();
    const bad = described({ name: "task", options: { filename: "{title}", autolink_target: "no" as never }, columns: [{ name: "title", type: "string", required: true }] });
    await expect(createTable(v.app, v.settings, bad)).rejects.toMatchObject({
      message: expect.stringContaining(`"autolink_target" must be true or false`),
      hint: expect.stringContaining("autolink_target: true"),
      docs: expect.stringContaining("/guides/read-and-write/automatic-links.md#choose-the-tables-a-link-may-point-to"),
    });
  });

  it("asks about a one-word name at the start of a sentence, a line, a list item or a label", async () => {
    const v = await vault({ "Areas/House.md": "x\n", "Areas/Work.md": "x\n", "Areas/Health.md": "x\n" });
    const body = "House: clean the bathroom.\nWork from the garden today.\n- Health above everything. Work well.\n";
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body });
    expect(bodyOf(v, film("Charade"))).toBe(body);
    expect(r.ambiguous_mentions?.map(({ text, reason, candidates }) => ({ text, reason, candidates }))).toEqual([
      { text: "House", reason: "sentence_start", candidates: ["Areas/House.md"] },
      { text: "Work", reason: "sentence_start", candidates: ["Areas/Work.md"] },
      { text: "Health", reason: "sentence_start", candidates: ["Areas/Health.md"] },
    ]);
    expect(r.ambiguous_mentions?.[0]?.hint).toMatch(/^"House" starts a sentence, a line or a label/);
    // inside a sentence the capital counts: linked, and the start of the line is not asked about
    const mid = await insertRow(v.app, v.settings, { table: "film", values: { title: "Notorious" }, body: "House: clean.\nThen back to the House.\n" });
    expect(bodyOf(v, film("Notorious"))).toBe("House: clean.\nThen back to the [[House]].\n");
    expect(mid.ambiguous_mentions).toBeUndefined();
  });

  it("links a one-word name only when written with a capital, whatever the name's own case", async () => {
    const v = await vault({ "Areas/house.md": "x\n", "Areas/Office.md": "---\naliases: [work]\n---\n" });
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: "Back to my house from work, then to the House for the Work.\n" });
    expect(bodyOf(v, film("Charade"))).toBe("Back to my house from work, then to the [[house|House]] for the [[Office|Work]].\n");
    expect(r.ambiguous_mentions).toBeUndefined();
  });

  it("never links a name glued to a path, a domain, an address or a snake_case word", async () => {
    const v = await vault({ "Areas/House.md": "x\n", "Shops/Greenmart.md": "x\n" });
    const glued = "See Documents/House/bill.pdf, the site Greenmart.com, the folder House_new, nora@House and C:\\House.\n";
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: `${glued}Shopping at Greenmart.\n` });
    expect(bodyOf(v, film("Charade"))).toBe(`${glued}Shopping at [[Greenmart]].\n`);
    expect(r.ambiguous_mentions).toBeUndefined();
    expect(r.links_added?.map((l) => l.text)).toEqual(["Greenmart"]);
  });

  it("leaves Dataview inline fields and Templater blocks alone", async () => {
    const v = await vault({ "Areas/House.md": "x\n" });
    const fields = [
      "project:: House",
      "- **area**:: House",
      "- [ ] tidy up [area:: House] today",
      "A note (place:: House) in short.",
      '<% tp.user.area("House") %> and <%* tR += "House" %>',
      "",
    ].join("\n");
    const r = await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" }, body: `${fields}Back to the House.\n` });
    expect(bodyOf(v, film("Charade"))).toBe(`${fields}Back to the [[House]].\n`);
    expect(r.links_added).toHaveLength(1);
  });

  it("escapes the alias bar in a table row without a leading bar, and only there", async () => {
    const v = await vault();
    const r = await insertRow(v.app, v.settings, {
      table: "film",
      values: { title: "Charade" },
      body: "Role | Actor\n--- | ---\nPeter | cary grant\n\nWith audrey hepburn and [[Notorious|the film]].\n",
    });
    expect(bodyOf(v, film("Charade"))).toBe(
      "Role | Actor\n--- | ---\nPeter | [[Cary Grant\\|cary grant]]\n\nWith [[Audrey Hepburn|audrey hepburn]] and [[Notorious|the film]].\n",
    );
    expect(r.links_added).toHaveLength(2);
  });

  it("links from the note's new path when the write renames it, in update_row and update_rows", async () => {
    const v = await vault();
    const sources: string[] = [];
    const mc = v.app.metadataCache as unknown as { fileToLinktext?: (f: { path: string; basename: string }, source: string, omitMd?: boolean) => string };
    const own = mc.fileToLinktext?.bind(mc);
    mc.fileToLinktext = (f, source, omitMd) => {
      if (f.path.startsWith(`${ACTOR}/`)) sources.push(source);
      return own ? own(f as never, source, omitMd) : f.basename;
    };
    await insertRow(v.app, v.settings, { table: "film", values: { title: "Charade" } });
    const one = await updateRow(v.app, v.settings, { table: "film", path: film("Charade"), set: { title: "Charade 1963" }, bodyAppend: "With Cary Grant." });
    expect(one.ok, JSON.stringify(one)).toBe(true);
    expect(v.exists(film("Charade 1963"))).toBe(true);
    expect(one.links_added).toEqual([{ path: film("Charade 1963"), text: "Cary Grant", target: actor("Cary Grant"), link: "[[Cary Grant]]" }]);
    const many = await updateRow(v.app, v.settings, { table: "film", path: film("Charade 1963"), set: { title: "Charade (1963)" }, body: "With Audrey Hepburn and Cary Grant.\n" });
    expect(many.ok, JSON.stringify(many)).toBe(true);
    expect(many.links_added?.map((l) => [l.path, l.text])).toEqual([
      [film("Charade (1963)"), "Audrey Hepburn"],
      [film("Charade (1963)"), "Cary Grant"],
    ]);
    expect(sources).toEqual([film("Charade 1963"), film("Charade (1963)"), film("Charade (1963)")]);
    expect(bodyOf(v, film("Charade (1963)"))).toBe("With [[Audrey Hepburn]] and [[Cary Grant]].\n");
  });
});

describe("automatic links through the HTTP API", () => {
  it("takes autolink on the write routes and on configure_database, and refuses a value that is not true or false", async () => {
    const v = await vault();
    const api = createPublicApi(v.app, () => v.settings);
    const handlers = createHandlers(v.app, () => v.settings, async () => {}, undefined, api);
    const call = (route: string, body: Record<string, unknown>) => dispatch(route, handlers[route]!, body);
    const bad = await call("/operations/insert_row/", { table: "film", values: { title: "Charade" }, body: "Cary Grant.\n", autolink: "no" });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: `insert_row: "autolink" must be a boolean, not string "no"`, hint: expect.any(String), docs: expect.stringMatching(/^https:\/\/datanotes\.dev\/.+\.md/) });
    const off = await call("/operations/insert_row/", { table: "film", values: { title: "Charade" }, body: "Cary Grant.\n", autolink: false });
    expect(off.status).toBe(200);
    expect(bodyOf(v, film("Charade"))).toBe("Cary Grant.\n");
    const one = await call("/operations/update_row/", { table: "film", path: film("Charade"), body_append: "Audrey Hepburn.", autolink: true });
    expect((one.json as { links_added: { text: string }[] }).links_added.map((l) => l.text)).toEqual(["Audrey Hepburn"]);
    const many = await call("/operations/update_row/", { table: "film", path: film("Charade"), body: "Cary Grant.\n", autolink: false });
    expect((many.json as { links_added?: unknown }).links_added).toBeUndefined();
    // update_rows writes no text: it takes no autolink
    expect((await call("/operations/update_rows/", { table: "film", where: {}, set: {}, autolink: false })).status).toBe(400);
    const cfg = await call("/operations/configure_database/", { autolink: false });
    expect((cfg.json as { config: { autolink: boolean } }).config.autolink).toBe(false);
    expect((await call("/operations/configure_database/", { autolink: "off" })).status).toBe(400);
    // a batch's writes link too: each step's result says what
    await call("/operations/configure_database/", { autolink: true });
    const batch = await call("/operations/batch/", {
      operations: [
        { op: "insert_row", table: "actor", values: { name: "Grace Kelly" } },
        { op: "insert_row", table: "film", values: { title: "Rear Window" }, body: "Grace Kelly and James Stewart.\n" },
      ],
    });
    expect(batch.status).toBe(200);
    const steps = (batch.json as { steps: { result: { links_added?: { target: string }[] } }[] }).steps;
    expect(steps[1]!.result.links_added?.map((l) => l.target)).toEqual([actor("Grace Kelly")]);
    expect(validate(responseSchema("batch"), JSON.parse(JSON.stringify(batch.json)))).toEqual([]);
    // the answer, links and doubts included, is what the catalogue describes
    v.write("Friends/Ingrid.md", "x\n");
    v.write("Directors/Bergman.md", "x\n");
    const both = await call("/operations/insert_row/", { table: "film", values: { title: "Notorious" }, body: "Ingrid Bergman and Cary Grant.\n" });
    expect(both.json).toMatchObject({ links_added: [{ text: "Cary Grant" }], ambiguous_mentions: [{ text: "Ingrid Bergman", reason: "adjacent" }] });
    expect(validate(responseSchema("insert_row"), JSON.parse(JSON.stringify(both.json)))).toEqual([]);
    expect(validate(responseSchema("configure_database"), JSON.parse(JSON.stringify(cfg.json)))).toEqual([]);
  });

  it("takes autolink_target on alter_table: true, false or \"default\"", async () => {
    const v = await vault();
    const api = createPublicApi(v.app, () => v.settings);
    const handlers = createHandlers(v.app, () => v.settings, async () => {}, undefined, api);
    const ddl = (body: Record<string, unknown>) => dispatch("/operations/alter_table/", handlers["/operations/alter_table/"]!, { table: "actor", ...body });
    const bad = await ddl({ autolink_target: "no" });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: `alter_table: "autolink_target" must be a boolean or "default", not string "no"`, docs: expect.stringContaining("#alter_table") });
    expect((await ddl({ autolink_target: false })).status).toBe(200);
    expect(v.read(METASTORE)).toContain("autolink_target: false");
    expect((await ddl({ autolink_target: "default" })).status).toBe(200);
    expect(v.read(METASTORE)).not.toContain("autolink_target");
    // the tool's arguments as the request sends them: as they are
    expect(operationRequest("alter_table", { table: "actor", autolink_target: "default" }).body).toEqual({ table: "actor", autolink_target: "default" });
    expect(operationRequest("alter_table", { table: "actor", autolink_target: true }).body).toEqual({ table: "actor", autolink_target: true });
  });
});
