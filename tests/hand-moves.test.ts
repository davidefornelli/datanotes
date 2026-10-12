/**
 * Links after a hand move (src/core/hand-moves.ts): a note renamed or moved outside the engine has
 * the links to its old path rewritten across the vault, rows and plain notes alike, as one
 * journaled operation that undo takes back, committed after the hand move in the history, and
 * reported on the change feed after the move with the move it follows. Nothing is written when an
 * editor already relinked, when the setting is off, or when the host cannot resolve links as they
 * were. On both hosts: the fake App of the in-memory tests and the headless Node host.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeFeed } from "../src/core/change-feed";
import { configureDatabase } from "../src/core/database";
import { INDEX_RETRY, logExternalEdits, onApplied, undoOperation, whileWriting, type AppliedOperation } from "../src/core/engine";
import { HAND_MOVE_TIMING, HandMoveRepairs, netMoves, repairHandMoves, setRepairGate } from "../src/core/hand-moves";
import { GitSync, runGit, type GitRunner } from "../src/node/git-sync";
import { gitBusy, gitDirOf } from "../src/node/git-state";
import type { NodeVault } from "../src/node/node-app";
import { NodeWatcher } from "../src/node/watcher";
import { insertRow } from "../src/core/rows";
import type { App, LinkRewrite } from "../src/core/host";
import { listMigrations } from "../src/core/journal";
import { NOOP_TELEMETRY, setTelemetry } from "../src/core/telemetry";
import { commitInfos } from "../src/core/transaction-log";
import { setBulkWriter } from "../src/core/vault-settle";
import { createDbVault, METASTORE, withTables, type DbVault } from "./helpers/db-vault";

INDEX_RETRY.delayMs = 1;

const TIMING = { ...HAND_MOVE_TIMING };
afterEach(() => {
  setTelemetry(NOOP_TELEMETRY);
  Object.assign(HAND_MOVE_TIMING, TIMING);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`${what}: not met after ${ms} ms`);
    await sleep(20);
  }
}

const ID = "{ name: id, type: string, unique: true, identity: uuid, required: true, dense: true }";
const TABLES = `person:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string, required: true }
    - { name: projects, type: list, items: link, ref: main.public.project }
project:
  options: { filename: "{name}" }
  columns:
    - ${ID}
    - { name: name, type: string, required: true }
    - { name: members, type: list, items: link, ref: main.public.person, inverse: projects }
    - { name: lead, type: link, ref: main.public.person }
    - { name: minutes, type: link }
`;

const ADA = "People/Ada Lovelace.md";
const KING = "People/Ada King.md";
const WEBSITE = "Projects/Website.md";
const KICKOFF = "Notes/Kickoff.md";

const ada = '---\ntable: main.public.person\nid: 01a0f000-0000-7000-8000-000000000001\nname: Ada Lovelace\nprojects:\n  - "[[Website]]"\n---\nCounts.\n';
const website = (who: string) =>
  `---\ntable: main.public.project\nid: 01a0f000-0000-7000-8000-000000000002\nname: Website\nmembers:\n  - "[[${who}]]"\nlead: "[[${who}]]"\n---\nAsk [[${who}#Contact|Ada]] first. ![[${who}]]\n`;
const kickoff = (link: string) => `---\nattendees:\n  - "[[${link}]]"\n---\nWith [Ada](../People/${link.replace(/ /g, "%20")}.md).\n`;

function vault(host?: "fake" | "node", extra: Record<string, string> = {}): DbVault {
  return createDbVault(
    {
      [METASTORE]: withTables(TABLES),
      [ADA]: ada,
      [WEBSITE]: website("Ada Lovelace"),
      [KICKOFF]: kickoff("Ada Lovelace"),
      ...extra,
    },
    {},
    host ? { host } : {},
  );
}

async function following(v: DbVault): Promise<ChangeFeed> {
  const feed = new ChangeFeed(v.app, () => v.settings);
  await feed.start();
  return feed;
}

/** Settle the batch, then the repair's events (recorded after it). */
const settle = async (feed: ChangeFeed) => {
  await feed.flush();
  await feed.flush();
};

/** Rename a note by hand; true when the host announced it (the headless host's own rename event). */
async function handRename(v: DbVault, from: string, to: string, feed?: ChangeFeed): Promise<void> {
  if (!(await v.rename(from, to))) feed?.moved(from, to); // the fake App has no events: the feed is told
}

describe("netMoves", () => {
  it("chains the moves of a batch and drops a file moved back to where it was", () => {
    expect([...netMoves([{ from: "a.md", to: "b.md" }, { from: "b.md", to: "c.md" }, { from: "x.md", to: "y.md" }])]).toEqual([
      ["a.md", "c.md"],
      ["x.md", "y.md"],
    ]);
    expect(netMoves([{ from: "a.md", to: "b.md" }, { from: "b.md", to: "a.md" }]).size).toBe(0);
  });
});

describe("repairHandMoves", () => {
  it("rewrites every link to the old path, in rows and plain notes, as one operation undo takes back", async () => {
    const v = vault();
    const applied: AppliedOperation[] = [];
    const off = onApplied(v.app, (e) => applied.push(e));
    await handRename(v, ADA, KING);
    const r = await repairHandMoves(v.app, v.settings, [{ from: ADA, to: KING }]);
    off();
    expect(r).toEqual({ migrationId: expect.any(String), paths: [KICKOFF, WEBSITE], moves: [{ from: ADA, to: KING }] });
    expect(v.read(WEBSITE)).toBe(website("Ada King"));
    expect(v.read(KICKOFF)).toBe(kickoff("Ada King").replace("../People/Ada%20King.md", "Ada%20King.md"));
    expect(v.read(KING)).toBe(ada); // links of its own still lead where they did
    expect(applied).toEqual([
      expect.objectContaining({ op: "repair_links", migrationId: r!.migrationId, paths: [KICKOFF, WEBSITE], handMoves: [{ from: ADA, to: KING }] }),
    ]);
    const [entry] = (await listMigrations(v.app, v.settings, { limit: 1 })).migrations;
    expect(entry).toMatchObject({ migration_id: r!.migrationId, op: "repair_links", summary: `repair the links after the hand move of ${ADA} to ${KING}`, files_changed: 2 });
    const undo = await undoOperation(v.app, v.settings, r!.migrationId);
    expect(undo.ok, JSON.stringify(undo)).toBe(true);
    expect(v.read(WEBSITE)).toBe(website("Ada Lovelace"));
    expect(v.read(KICKOFF)).toBe(kickoff("Ada Lovelace"));
  });

  it("with automatic links: the repair rewrites only the links it follows, and later writes link the new name", async () => {
    const v = vault();
    const PLAN = "Notes/Plan.md";
    const plan = "Ada King joins the Website. See [[Ada Lovelace]].\n";
    v.write(PLAN, plan);
    await handRename(v, ADA, KING);
    const r = await repairHandMoves(v.app, v.settings, [{ from: ADA, to: KING }]);
    expect(r?.paths).toEqual([KICKOFF, PLAN, WEBSITE]);
    // the old link follows the move; the names in the text stay text: a repair is no write of a body
    expect(v.read(PLAN)).toBe("Ada King joins the Website. See [[Ada King]].\n");
    const w = await insertRow(v.app, v.settings, { table: "project", values: { name: "Archive" }, body: "Ada King leads it; Ada Lovelace was her name before.\n" });
    expect(w.ok, JSON.stringify(w)).toBe(true);
    expect(w.links_added?.map((l) => [l.text, l.target])).toEqual([["Ada King", KING]]);
    expect(w.ambiguous_mentions).toBeUndefined();
  });

  it("commits the hand move first, then the repair, in the history of the tables it wrote", async () => {
    const v = vault();
    await configureDatabase(v.app, v.settings, { history: true }, async () => {});
    await logExternalEdits(v.app, v.settings);
    await handRename(v, ADA, KING);
    const r = await repairHandMoves(v.app, v.settings, [{ from: ADA, to: KING }]);
    expect((await commitInfos(v.app, v.settings, "main.public.person")).map((c) => c.operation)).toEqual(["CREATE TABLE", "EXTERNAL_EDIT"]);
    const project = await commitInfos(v.app, v.settings, "main.public.project");
    expect(project.map((c) => c.operation)).toEqual(["CREATE TABLE", "REPAIR LINKS"]);
    expect(project[1]).toMatchObject({ migrationId: r!.migrationId, operationParameters: { moves: [{ from: ADA, to: KING }] } });
  });

  it("writes nothing when an editor already relinked, when the setting is off, or when the host cannot resolve links as they were", async () => {
    const v = vault();
    await handRename(v, ADA, KING);
    const before = (await listMigrations(v.app, v.settings)).total;
    v.settings.repairLinksOnHandMove = false;
    expect(await repairHandMoves(v.app, v.settings, [{ from: ADA, to: KING }])).toBeNull();
    v.settings.repairLinksOnHandMove = true;
    const blind = { ...v.app, fileManager: { renameFile: v.app.fileManager.renameFile, processFrontMatter: v.app.fileManager.processFrontMatter } } as App;
    expect(await repairHandMoves(blind, v.settings, [{ from: ADA, to: KING }])).toBeNull();
    expect(await repairHandMoves(v.app, v.settings, [{ from: ADA, to: KING }, { from: KING, to: ADA }])).toBeNull();
    expect(v.read(WEBSITE)).toBe(website("Ada Lovelace"));
    // an editor (Obsidian, on its own renames) relinked every note already
    v.write(WEBSITE, website("Ada King"));
    v.write(KICKOFF, kickoff("Ada King"));
    expect(await repairHandMoves(v.app, v.settings, [{ from: ADA, to: KING }])).toBeNull();
    expect((await listMigrations(v.app, v.settings)).total).toBe(before);
  });

  it("leaves a note that changed since it was read (or went away) as it is, and writes the others", async () => {
    const v = vault();
    const logs: string[] = [];
    setTelemetry({ log: (_s, body, attrs) => void logs.push(`${body} ${String(attrs?.path ?? "")}`), flush: async () => {} });
    await handRename(v, ADA, KING);
    const plan = (await v.app.fileManager.linksAfterMove!(new Map([[ADA, KING]])))!;
    const stale: LinkRewrite[] = [...plan.map((p) => (p.path === WEBSITE ? { ...p, before: "an older text" } : p)), { path: "Gone.md", before: "", after: "x" }];
    const app = { ...v.app, fileManager: { ...v.app.fileManager, linksAfterMove: async () => stale } } as App;
    const r = await repairHandMoves(app, v.settings, [{ from: ADA, to: KING }]);
    expect(r!.paths).toEqual([KICKOFF]);
    expect(v.read(WEBSITE)).toBe(website("Ada Lovelace"));
    expect(logs).toContain(`datanotes left a note that changed meanwhile as it is ${WEBSITE}`);
    const none = { ...app, fileManager: { ...app.fileManager, linksAfterMove: async () => [stale[0]!] } } as App;
    expect(await repairHandMoves(none, v.settings, [{ from: ADA, to: KING }])).toBeNull();
  });

  it("writes many notes as the host runs bulk writes", async () => {
    const v = vault();
    for (let i = 0; i < 50; i++) v.write(`Notes/n${i}.md`, `See [[Ada Lovelace]] (${i}).\n`);
    let bulks = 0;
    setBulkWriter(v.app, async (work) => {
      bulks++;
      return work();
    });
    await handRename(v, ADA, KING);
    const r = await repairHandMoves(v.app, v.settings, [{ from: ADA, to: KING }]);
    setBulkWriter(v.app, null);
    expect([r!.paths.length, bulks]).toEqual([52, 1]);
    expect(v.read("Notes/n7.md")).toBe("See [[Ada King]] (7).\n");
  });
});

describe("the change feed", () => {
  it("a row renamed by hand: its move breaks nothing, and the repair's events name the move", async () => {
    const v = vault();
    const feed = await following(v);
    const since = feed.lastSeq;
    await handRename(v, ADA, KING, feed);
    await settle(feed);
    const events = (await feed.read({ since })).events;
    expect(events.map((e) => [e.op, e.path, e.source, e.operation ?? ""])).toEqual([
      ["move", KING, "external", ""],
      ["update", WEBSITE, "engine", "repair_links"],
    ]);
    expect(events[0]!.violations).toEqual([]);
    expect(events[1]).toMatchObject({ changes: { members: { before: ["[[Ada Lovelace]]"], after: ["[[Ada King]]"] } }, cause: [{ path: KING, oldPath: ADA, seq: events[0]!.seq }] });
    await feed.stop();
  });

  it("a plain note moved by hand, and a row deleted and created again elsewhere (git), have their links repaired too", async () => {
    const v = vault();
    v.write(WEBSITE, website("Ada Lovelace").replace("---\nAsk", 'minutes: "[[Notes/Kickoff]]"\n---\nAsk'));
    const feed = await following(v);
    let since = feed.lastSeq;
    await handRename(v, KICKOFF, "Notes/2026/Kickoff.md", feed);
    await settle(feed);
    let events = (await feed.read({ since })).events;
    expect(events.map((e) => [e.op, e.path])).toEqual([["update", WEBSITE]]); // a plain note has no event of its own
    expect(events[0]).toMatchObject({ changes: { minutes: { before: "[[Notes/Kickoff]]", after: "[[Kickoff]]" } } });
    expect(events[0]!.cause).toEqual([{ path: "Notes/2026/Kickoff.md", oldPath: KICKOFF }]);
    // git: the old file deleted, a new one with the same id (and an edit) created
    since = feed.lastSeq;
    v.write(KING, ada.replace("Counts.", "Counts, and writes."));
    v.remove(ADA);
    feed.touch(KING);
    feed.touch(ADA);
    await settle(feed);
    events = (await feed.read({ since })).events;
    expect(events.map((e) => [e.op, e.path, e.operation ?? ""])).toEqual([
      ["move", KING, ""],
      ["update", WEBSITE, "repair_links"],
    ]);
    expect(v.read(WEBSITE)).toContain('lead: "[[Ada King]]"');
    await feed.stop();
  });

  it("a repair that fails is logged; the move is still recorded", async () => {
    const v = vault();
    const logs: string[] = [];
    setTelemetry({ log: (_s, body) => void logs.push(body), flush: async () => {} });
    const feed = await following(v);
    const since = feed.lastSeq;
    const fm = v.app.fileManager as { linksAfterMove?: unknown };
    fm.linksAfterMove = async () => {
      throw new Error("the disk is gone");
    };
    await handRename(v, ADA, KING, feed);
    await settle(feed);
    expect(logs).toContain("datanotes could not repair the links after a hand move");
    expect((await feed.read({ since })).events.map((e) => e.op)).toEqual(["move"]);
    await feed.stop();
  });
});

/** Another program moves a note on disk, and the headless host's watcher reports both paths together. */
function diskMove(v: DbVault, from: string, to: string): void {
  fs.mkdirSync(path.dirname(v.abs(to)), { recursive: true });
  fs.renameSync(v.abs(from), v.abs(to));
  (v.app.vault as unknown as NodeVault).syncPaths([from, to]);
}

describe("hand moves seen while the engine writes (headless host)", () => {
  it("a rename seen during a long engine write is still published and repaired", async () => {
    const v = vault("node");
    const feed = await following(v);
    const since = feed.lastSeq;
    await whileWriting(v.app, async () => diskMove(v, ADA, KING));
    await settle(feed);
    const events = (await feed.read({ since })).events;
    expect(events.map((e) => [e.op, e.path, e.source])).toEqual([
      ["move", KING, "external"],
      ["update", WEBSITE, "engine"],
    ]);
    expect(events[0]!.violations).toEqual([]);
    expect(v.read(WEBSITE)).toBe(website("Ada King"));
    await feed.stop();
  });

  it("a rename seen when the watcher starts again after a bulk repair of 60 notes is still published and repaired", async () => {
    const SITE = "Projects/Website 2026.md";
    const notes = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Notes/n${i}.md`, `See [[Ada Lovelace]] on [[Website]] (${i}).\n`]));
    const v = vault("node", notes);
    const host = v.app.vault as unknown as NodeVault;
    // as the service: the watcher stops during bulk writes, then compares the whole tree
    const watcher = new NodeWatcher(host, { mode: "poll", intervalMs: 3_600_000 });
    watcher.start();
    let moved = false;
    setBulkWriter(v.app, async (work) => {
      watcher.stop();
      try {
        const r = await work();
        if (!moved) {
          moved = true;
          fs.renameSync(v.abs(WEBSITE), v.abs(SITE)); // by hand, while the engine writes
        }
        return r;
      } finally {
        watcher.start(); // still inside the engine's write
      }
    });
    try {
      const feed = await following(v);
      const since = feed.lastSeq;
      diskMove(v, ADA, KING);
      await settle(feed);
      await settle(feed);
      const events = (await feed.read({ since })).events;
      expect(events.map((e) => [e.op, e.path, e.operation ?? ""])).toEqual([
        ["move", KING, ""],
        ["update", WEBSITE, "repair_links"],
        ["move", SITE, ""],
        ["update", KING, "repair_links"],
      ]);
      expect(v.read("Notes/n7.md")).toBe("See [[Ada King]] on [[Website 2026]] (7).\n");
      await feed.stop();
    } finally {
      setBulkWriter(v.app, null);
      watcher.stop();
    }
  });
});

describe("the repair waits for a quiet vault", () => {
  it("plans once no vault event came for the quiet time, and fixes only what an editor left", async () => {
    HAND_MOVE_TIMING.quietMs = 400;
    const v = vault();
    const repairs = new HandMoveRepairs(v.app, () => v.settings);
    await handRename(v, ADA, KING);
    expect(await repairs.add([{ from: ADA, to: KING }], new Set())).toBe(true);
    await sleep(250);
    // the editor relinks a note itself (Obsidian after its own rename): the quiet time starts again
    v.write(WEBSITE, website("Ada King"));
    repairs.activity();
    await sleep(250);
    expect(v.read(KICKOFF)).toBe(kickoff("Ada Lovelace"));
    await until(() => !repairs.pending && v.read(KICKOFF) !== kickoff("Ada Lovelace"), "the repair");
    await repairs.flush(); // the repair under way
    expect(v.read(KICKOFF)).toBe(kickoff("Ada King").replace("../People/Ada%20King.md", "Ada%20King.md"));
    const [entry] = (await listMigrations(v.app, v.settings, { limit: 1 })).migrations;
    expect(entry).toMatchObject({ op: "repair_links", files_changed: 1 });
    await repairs.stop();
  });

  it("a vault event while it plans throws the plan away: it plans again after the next quiet time", async () => {
    HAND_MOVE_TIMING.quietMs = 100;
    const v = vault();
    const repairs = new HandMoveRepairs(v.app, () => v.settings);
    await handRename(v, ADA, KING);
    await repairs.add([{ from: ADA, to: KING }], new Set());
    const fm = v.app.fileManager as { linksAfterMove: NonNullable<App["fileManager"]["linksAfterMove"]> };
    const real = fm.linksAfterMove.bind(fm);
    let plans = 0;
    fm.linksAfterMove = async (moves, options) => {
      const plan = await real(moves, options);
      if (++plans === 1) repairs.activity(); // something wrote meanwhile
      return plan;
    };
    await repairs.flush();
    expect([plans, repairs.pending, v.read(WEBSITE)]).toEqual([1, true, website("Ada Lovelace")]);
    await until(() => !repairs.pending, "the second plan");
    await repairs.flush(); // the repair under way
    expect([plans, v.read(WEBSITE)]).toEqual([2, website("Ada King")]);
    await repairs.stop();
  });

  it("waits while the host says the vault is busy, and tries again; stopped while busy, it repairs nothing", async () => {
    HAND_MOVE_TIMING.quietMs = 50;
    HAND_MOVE_TIMING.retryMs = 50;
    const logs: string[] = [];
    setTelemetry({ log: (_s, body, attrs) => void logs.push(`${body}${attrs?.reason ? `: ${String(attrs.reason)}` : ""}`), flush: async () => {} });
    const v = vault();
    let busy: () => string | null = () => "git sync is pulling";
    setRepairGate(v.app, () => busy());
    const repairs = new HandMoveRepairs(v.app, () => v.settings);
    await handRename(v, ADA, KING);
    await repairs.add([{ from: ADA, to: KING }], new Set());
    await repairs.flush();
    await sleep(200); // tried again a few times, logged once
    expect([repairs.pending, v.read(WEBSITE)]).toEqual([true, website("Ada Lovelace")]);
    expect(logs.filter((l) => l.startsWith("datanotes waits"))).toEqual(["datanotes waits to repair the links after a hand move: git sync is pulling"]);
    busy = () => null;
    await until(() => !repairs.pending, "the repair once git is done");
    await repairs.flush(); // the repair under way
    expect(v.read(WEBSITE)).toBe(website("Ada King"));
    // a gate that cannot tell counts as busy; stopped meanwhile, the moves are left (logged)
    busy = () => {
      throw new Error("cannot read .git");
    };
    await handRename(v, KING, ADA);
    await repairs.add([{ from: KING, to: ADA }], new Set());
    await repairs.stop();
    expect(v.read(WEBSITE)).toBe(website("Ada King"));
    expect(logs).toContain("datanotes waits to repair the links after a hand move: cannot read .git");
    expect(logs).toContain("datanotes did not repair the links after a hand move: the vault was busy when it stopped");
    expect(await repairs.add([{ from: ADA, to: KING }], new Set())).toBe(false); // stopped
    setRepairGate(v.app, null);
  });
});

describe("a → b, then c → a", () => {
  it("a link to a that was written before the moves follows a to b; one written with them stays", async () => {
    const v = vault(undefined, {
      "Notes/A.md": "The first note, which moves to B.\n",
      "Notes/C.md": "The third note, which takes the name A.\n",
      "Notes/N1.md": "Linked before: [[A]].\n",
      "Notes/N2.md": "Linked before: [[C]].\n",
      "Notes/N3.md": "Nothing yet.\n",
    });
    const repairs = new HandMoveRepairs(v.app, () => v.settings);
    await handRename(v, "Notes/A.md", "Notes/B.md");
    await repairs.add([{ from: "Notes/A.md", to: "Notes/B.md" }], new Set());
    // a later batch: c takes the name a, and a note written with it links the new a
    await handRename(v, "Notes/C.md", "Notes/A.md");
    v.write("Notes/N3.md", "Linked after: [[A]].\n");
    await repairs.add([{ from: "Notes/C.md", to: "Notes/A.md" }], new Set(["Notes/N3.md"]));
    await repairs.flush();
    expect([v.read("Notes/N1.md"), v.read("Notes/N2.md"), v.read("Notes/N3.md")]).toEqual(["Linked before: [[B]].\n", "Linked before: [[A]].\n", "Linked after: [[A]].\n"]);
    await repairs.stop();
  });
});

describe("rows moved while the engine was stopped", () => {
  it("are found by id at the next start and their links repaired; a saved path that holds a file again is left", async () => {
    const v = vault();
    let feed = await following(v);
    await feed.stop(); // saves where each row is
    await v.rename(ADA, KING); // while the engine is stopped
    feed = await following(v);
    const since = feed.lastSeq;
    await feed.flush();
    const events = (await feed.read({ since })).events;
    expect(events.map((e) => [e.op, e.path, e.operation])).toEqual([["update", WEBSITE, "repair_links"]]);
    expect(events[0]!.cause).toEqual([{ path: KING, oldPath: ADA }]);
    expect(v.read(WEBSITE)).toBe(website("Ada King"));
    await feed.stop();
    // moved again, and a new note at the saved path: links to that path are not the row's for sure
    await v.rename(KING, "People/Ada K.md");
    v.write(KING, "A new note under the old name, no row.\n");
    feed = await following(v);
    await feed.flush();
    expect(v.read(WEBSITE)).toBe(website("Ada King"));
    await feed.stop();
    // saved paths that cannot be read: nothing is repaired, the feed runs
    v.write("store:hand-moves/rows.json", "{ not json");
    const logs: string[] = [];
    setTelemetry({ log: (_s, body) => void logs.push(body), flush: async () => {} });
    feed = await following(v);
    expect(logs).toContain("datanotes could not read the saved row paths");
    await feed.stop();
  });
});

describe("hand moves and git", { timeout: 60_000 }, () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  it("a git sync pull that renames notes: the move is published at once, the links repaired once the pull is over", async () => {
    const v = vault("node");
    git(v.root, "init", "-q", "-b", "main");
    // Git for Windows sets core.autocrlf=true system-wide: the notes keep their LF endings
    for (const [k, val] of [["core.autocrlf", "false"], ["user.name", "Test"], ["user.email", "test@example.com"]] as const) git(v.root, "config", k, val);
    git(v.root, "add", "-A");
    git(v.root, "commit", "-q", "-m", "init");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hand-moves-git-"));
    const remote = path.join(base, "remote.git");
    git(base, "init", "-q", "--bare", "-b", "main", remote);
    git(v.root, "remote", "add", "origin", remote);
    git(v.root, "push", "-q", "-u", "origin", "main");
    // another machine renames a row and pushes
    const other = path.join(base, "other");
    git(base, "clone", "-q", "-c", "core.autocrlf=false", remote, other);
    for (const [k, val] of [["user.name", "Other"], ["user.email", "other@example.com"]] as const) git(other, "config", k, val);
    git(other, "mv", ADA, KING);
    git(other, "commit", "-q", "-m", "rename Ada");
    git(other, "push", "-q");

    const feed = await following(v);
    const host = v.app.vault as unknown as NodeVault;
    const during: string[] = [];
    // the watcher reports the pull's renames while it still runs
    const run: GitRunner = async (args, cwd) => {
      const r = await runGit(args, cwd);
      if (args[0] === "pull") {
        host.syncPaths([ADA, KING]);
        await feed.flush();
        during.push(v.read(WEBSITE));
      }
      return r;
    };
    const sync = new GitSync({ vault: v.root, run, intervalMs: 3_600_000 });
    const gitDir = gitDirOf(v.root);
    setRepairGate(v.app, () => gitBusy(gitDir, sync.pulling));
    try {
      expect(await sync.start()).toBe(true);
      const since = feed.lastSeq;
      await sync.cycle();
      sync.stop();
      expect(sync.status.blocked).toBeUndefined();
      expect(during).toEqual([website("Ada Lovelace")]); // not repaired while pulling
      expect((await feed.read({ since })).events.map((e) => [e.op, e.path])).toEqual([["move", KING]]);
      await feed.flush(); // the pull is over
      expect(v.read(WEBSITE)).toBe(website("Ada King"));

      // a git command under way (its index.lock): the repair waits too
      fs.writeFileSync(path.join(gitDir!, "index.lock"), "");
      diskMove(v, KING, "People/Ada K.md");
      await feed.flush();
      expect(v.read(WEBSITE)).toBe(website("Ada King"));
      fs.rmSync(path.join(gitDir!, "index.lock"));
      await feed.flush();
      expect(v.read(WEBSITE)).toBe(website("Ada K"));
      await feed.stop();
    } finally {
      setRepairGate(v.app, null);
    }
  });

  it("gitBusy names a pull, a rebase, a merge or a git command in progress; gitDirOf follows a .git file", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-state-"));
    const dir = path.join(repo, ".git");
    fs.mkdirSync(dir);
    expect([gitDirOf(path.join(repo, "Vault")), gitBusy(dir), gitBusy(dir, true), gitBusy(null)]).toEqual([dir, null, "git sync is pulling", null]);
    for (const [file, what] of [["rebase-merge", "a rebase"], ["rebase-apply", "a rebase"], ["MERGE_HEAD", "a merge"], ["index.lock", "a git command"]]) {
      fs.writeFileSync(path.join(dir, file!), "");
      expect(gitBusy(dir)).toBe(`${what} is in progress in the vault's git repository (${file})`);
      fs.rmSync(path.join(dir, file!));
    }
    // a worktree: its .git is a file naming its git folder
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "git-state-wt-"));
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${dir}\n`);
    expect(gitDirOf(wt)).toBe(dir);
    fs.writeFileSync(path.join(wt, ".git"), "not a git file\n");
    expect(gitDirOf(wt)).toBe(gitDirOf(path.dirname(wt))); // no git folder named: it looks further up
  });
});
