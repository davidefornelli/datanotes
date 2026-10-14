/**
 * The files of a table's transaction log (src/core/log-files.ts) at their edges: segments that end
 * torn or hold a version that does not follow, versions written where another writer got first,
 * segments sealed by size, and checkpoints whose manifest or parts are missing or unreadable.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../src/core/file-cache";
import type { App, StoreAdapter } from "../src/core/host";
import {
  appendVersion,
  CHECKPOINT_PART,
  forgetLogTocs,
  framed,
  latestOf,
  logToc,
  manifestFiles,
  pad,
  parseSegment,
  readManifest,
  readPart,
  SEGMENT_POLICY,
  versionText,
  versionTexts,
  writeManifestCheckpoint,
  writeSealedSegments,
} from "../src/core/log-files";
import { nodeStoreFiles } from "../src/node/store-files";
import { folderStore } from "./helpers/db-vault";

const DIR = "store:transaction_log/main.a.b";
const policies = { segment: { ...SEGMENT_POLICY }, part: { ...CHECKPOINT_PART } };
afterEach(() => {
  Object.assign(SEGMENT_POLICY, policies.segment);
  Object.assign(CHECKPOINT_PART, policies.part);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-log-files-"));
/** A version's text, as a file of its own holds it. */
const version = (v: number) => `${JSON.stringify({ commitInfo: { version: v, timestamp: `2026-10-01T10:00:0${v % 10}.000Z`, operation: "WRITE" } })}\n${JSON.stringify({ add: { path: `R/${v}.md`, hash: "h", size: 1, content: "x" } })}\n`;
/** An app whose store is `adapter`, on the folder `dir`. */
function storeApp(adapter: StoreAdapter): App {
  return { store: adapter } as unknown as App;
}
/** A store on a folder of the disk, as the headless engine has it (stat, binary files). */
function diskStore(): { app: App; dir: string; file(rel: string): string } {
  const dir = tmp();
  return { app: storeApp(nodeStoreFiles(dir)), dir, file: (rel) => path.join(dir, "transaction_log", "main.a.b", rel) };
}

describe("a segment's versions", () => {
  const two = framed(0, version(0)) + framed(1, version(1));

  it("are read up to the first that is not whole", () => {
    expect(parseSegment("")).toEqual({ commits: [], validEnd: 0 });
    expect(parseSegment(two).commits.map((c) => c.version)).toEqual([0, 1]);
    expect(parseSegment(two).validEnd).toBe(two.length);
    const first = framed(0, version(0)).length;
    for (const tail of [
      '{"commit":{"version":1,"lines":2', // a header cut before its line break
      "not json\n", // a header that is no JSON
      '{"commit":{"version":1,"lines":0}}\n', // a header of no line
      '{"other":true}\n',
      '{"commit":{"version":"1","lines":2}}\n',
      `${JSON.stringify({ commit: { version: 1, lines: 2, hash: contentHash(version(1)) } })}\n${version(1).split("\n")[0]}\n`, // one line of two
      `${JSON.stringify({ commit: { version: 1, lines: 2, hash: "0" } })}\n${version(1)}`, // another text than its hash
      framed(3, version(3)), // not the next version
    ]) {
      const r = parseSegment(framed(0, version(0)) + tail);
      expect([r.commits.map((c) => c.version), r.validEnd]).toEqual([[0], first]);
    }
    // a header without a hash is taken as it says
    expect(parseSegment(`${JSON.stringify({ commit: { version: 4, lines: 2 } })}\n${version(4)}`).commits.map((c) => c.version)).toEqual([4]);
  });

  it("of a sealed segment that is not whole any more are refused when read", async () => {
    const app = storeApp(folderStore(tmp()));
    await writeSealedSegments(app, DIR, [0, 1, 2].map((v) => ({ version: v, text: version(v) })));
    const toc = await logToc(app, DIR);
    expect(toc.versions).toEqual([0, 1, 2]);
    const file = toc.segments[0]!.path;
    const store = app.store!;
    await store.write(file.slice("store:".length), framed(0, version(0)) + framed(1, version(1)).replace('"version":1', '"version":5'));
    forgetLogTocs(app);
    const again = await logToc(app, DIR);
    expect(await versionText(app, again, 0)).toBe(version(0));
    await expect(versionText(app, again, 1)).rejects.toThrow(`${file} does not hold version 1 whole`);
  });

  it("written as sealed segments: none for no version, a new segment at a gap and at the size limits, a segment there already kept", async () => {
    const app = storeApp(folderStore(tmp()));
    expect(await writeSealedSegments(app, DIR, [])).toEqual([]);
    SEGMENT_POLICY.maxVersions = 2;
    const written = await writeSealedSegments(app, DIR, [0, 1, 2, 4, 5].map((v) => ({ version: v, text: version(v) })));
    expect(written.map((p) => p.slice(DIR.length + 1))).toEqual([
      "00000000000000000000-00000000000000000001.segment.jsonl",
      "00000000000000000002-00000000000000000002.segment.jsonl",
      "00000000000000000004-00000000000000000005.segment.jsonl",
    ]);
    SEGMENT_POLICY.maxVersions = 1000;
    SEGMENT_POLICY.maxBytes = 1;
    expect((await writeSealedSegments(app, DIR, [7, 8].map((v) => ({ version: v, text: version(v) })))).map((p) => p.slice(DIR.length + 1))).toEqual([
      "00000000000000000007-00000000000000000007.segment.jsonl",
      "00000000000000000008-00000000000000000008.segment.jsonl",
    ]);
    // written again: the segments there are kept as they are
    expect(await writeSealedSegments(app, DIR, [7].map((v) => ({ version: v, text: "changed" })))).toEqual([`${DIR}/00000000000000000007-00000000000000000007.segment.jsonl`]);
    forgetLogTocs(app);
    expect(await versionTexts(app, await logToc(app, DIR), [7])).toEqual([version(7)]);
  });

  it("a sealed segment a crash tore is written again; one that holds its versions whole is kept", async () => {
    const app = storeApp(folderStore(tmp()));
    const rel = `${DIR.slice("store:".length)}/${pad(0)}-${pad(2)}.segment.jsonl`;
    const whole = [0, 1, 2].map((v) => framed(v, version(v))).join("");
    for (const torn of [
      framed(0, version(0)) + framed(1, version(1)).slice(0, 20), // a torn tail
      framed(0, version(0)) + framed(1, version(1)), // cut at a version's end: two versions of three
      framed(5, version(5)) + framed(6, version(6)) + framed(7, version(7)), // three versions, other ones
    ]) {
      await app.store!.write(rel, torn);
      expect(await writeSealedSegments(app, DIR, [0, 1, 2].map((v) => ({ version: v, text: version(v) })))).toEqual([`${DIR}/${pad(0)}-${pad(2)}.segment.jsonl`]);
      expect(await app.store!.read(rel)).toBe(whole);
    }
  });

  it("a version a torn sealed segment lacks is read from an older segment, else from its own file", async () => {
    const app = storeApp(folderStore(tmp()));
    const rel = (name: string) => `${DIR.slice("store:".length)}/${name}`;
    for (const v of [0, 1, 2]) await app.store!.write(rel(`${pad(v)}.json`), version(v));
    await app.store!.write(rel(`${pad(0)}-${pad(2)}.segment.jsonl`), framed(0, version(0)) + framed(1, version(1)).slice(0, 20));
    expect(await versionTexts(app, await logToc(app, DIR), [0, 1, 2])).toEqual([0, 1, 2].map(version));
    // an older whole segment for the same versions: read before the files
    const other = storeApp(folderStore(tmp()));
    await writeSealedSegments(other, DIR, [0, 1, 2].map((v) => ({ version: v, text: version(v) })));
    await other.store!.write(rel(`${pad(1)}-${pad(2)}.segment.jsonl`), framed(1, version(1)).slice(0, 20));
    const toc = await logToc(other, DIR);
    expect(toc.segments.map((s) => s.first)).toEqual([0, 1]);
    expect(await versionText(other, toc, 1)).toBe(version(1));
  });

  it("of more segments than are kept in memory read each segment again", async () => {
    SEGMENT_POLICY.maxVersions = 1;
    const app = storeApp(folderStore(tmp()));
    await writeSealedSegments(app, DIR, [0, 1, 2, 3, 4].map((v) => ({ version: v, text: version(v) })));
    const toc = await logToc(app, DIR);
    expect(await versionTexts(app, toc, [0, 1, 2, 3, 4, 0])).toEqual([0, 1, 2, 3, 4, 0].map(version));
  });
});

describe("writing a version", () => {
  it("refuses a version that does not follow the log's newest", async () => {
    const app = storeApp(folderStore(tmp()));
    await appendVersion(app, DIR, 0, version(0), "files");
    await expect(appendVersion(app, DIR, 2, version(2), "files")).rejects.toThrow(`log moved on: ${DIR} is at version 0, not 1`);
    await expect(appendVersion(app, DIR, 0, version(0), "segments")).rejects.toThrow(`log file exists: ${DIR}/00000000000000000000.json`);
  });

  it("refuses to write over a version another writer wrote, as a file or as a new segment", async () => {
    // a store whose folders tell no change (the other writer's file is found as the version is written)
    const dir = tmp();
    const disk = nodeStoreFiles(dir);
    const store: StoreAdapter = { ...disk, stat: async (p) => (p.endsWith(".json") || p.endsWith(".jsonl") ? disk.stat!(p) : { size: 0, mtime: 1 }) };
    const app = storeApp(store);
    await appendVersion(app, DIR, 0, version(0), "files");
    fs.writeFileSync(path.join(dir, "transaction_log", "main.a.b", "00000000000000000001.json"), version(1));
    await expect(appendVersion(app, DIR, 1, version(1), "files")).rejects.toThrow(`log file exists: ${DIR}/00000000000000000001.json`);
    fs.rmSync(path.join(dir, "transaction_log", "main.a.b", "00000000000000000001.json"));
    fs.writeFileSync(path.join(dir, "transaction_log", "main.a.b", "00000000000000000001.segment.jsonl"), "");
    await expect(appendVersion(app, DIR, 1, version(1), "segments")).rejects.toThrow(`log file exists: ${DIR}/00000000000000000001.segment.jsonl`);
  });

  it("to a segment another writer appended to meanwhile is refused", async () => {
    const s = diskStore();
    await appendVersion(s.app, DIR, 0, version(0), "segments");
    expect((await logToc(s.app, DIR)).segments[0]!.bytes).toBe(fs.statSync(s.file("00000000000000000000.segment.jsonl")).size);
    fs.appendFileSync(s.file("00000000000000000000.segment.jsonl"), framed(1, version(1)));
    await expect(appendVersion(s.app, DIR, 1, version(1), "segments")).rejects.toThrow(`log moved on: ${DIR}/00000000000000000000.segment.jsonl changed`);
  });

  it("starts a new segment once the open one holds its share of bytes, and seals the open one", async () => {
    SEGMENT_POLICY.maxBytes = 300;
    const s = diskStore();
    for (const v of [0, 1, 2]) await appendVersion(s.app, DIR, v, version(v), "segments");
    expect(fs.readdirSync(path.dirname(s.file("x")))).toEqual(["00000000000000000000-00000000000000000001.segment.jsonl", "00000000000000000002.segment.jsonl"]);
    forgetLogTocs(s.app);
    expect((await logToc(s.app, DIR)).versions).toEqual([0, 1, 2]);
  });

  it("removes an open segment that holds no whole version (left empty, or torn in its first, by a crash)", async () => {
    const s = diskStore();
    await appendVersion(s.app, DIR, 0, version(0), "files");
    fs.writeFileSync(s.file("00000000000000000001.segment.jsonl"), "");
    fs.writeFileSync(s.file("00000000000000000005.segment.jsonl"), '{"commit":{"version":5,"lines":2}}\n{"commitInfo"');
    forgetLogTocs(s.app);
    const toc = await logToc(s.app, DIR);
    expect([latestOf(toc), toc.segments.map((x) => [x.first, x.last])]).toEqual([0, [[1, 0], [5, 4]]]);
    expect(await appendVersion(s.app, DIR, 1, version(1), "segments")).toEqual([
      `${DIR}/00000000000000000001.segment.jsonl: 0 characters of a torn version cut, the file removed`,
      `${DIR}/00000000000000000005.segment.jsonl: 48 characters of a torn version cut, the file removed`,
    ]);
    expect(fs.readdirSync(path.dirname(s.file("x")))).toEqual(["00000000000000000000.json", "00000000000000000001.segment.jsonl"]);
    forgetLogTocs(s.app);
    expect((await logToc(s.app, DIR)).versions).toEqual([0, 1]);
  });
});

describe("a checkpoint's manifest and parts", () => {
  const head = { version: 3, timestamp: "2026-10-01T10:00:00.000Z", entry: { columns: [] } };
  const rows = [
    { path: "R/a.md", hash: "ha", content: "text a" },
    { path: "R/b.md", hash: "hb", content: "text b" },
  ];

  it("of a table without rows is a manifest without rows and one empty part; one there already is kept", async () => {
    const app = storeApp(folderStore(tmp()));
    expect(await writeManifestCheckpoint(app, DIR, head, [])).toEqual([`${DIR}/00000000000000000003.part-0.jsonl`, `${DIR}/00000000000000000003.manifest.jsonl`]);
    const m = await readManifest(app, DIR, `${DIR}/00000000000000000003.manifest.jsonl`);
    expect(m).toEqual({ head: { format: 2, ...head, rows: 0, parts: ["00000000000000000003.part-0.jsonl"] }, rows: [] });
    expect(await readPart(app, DIR, "00000000000000000003.part-0.jsonl")).toEqual(new Map());
    expect(await writeManifestCheckpoint(app, DIR, head, rows)).toEqual([]);
  });

  it("missing, empty, of another format, without its next files, of another row count or no JSON reads as none", async () => {
    const dir = tmp();
    const app = storeApp(folderStore(dir));
    CHECKPOINT_PART.maxChars = 30; // a manifest file per row
    await writeManifestCheckpoint(app, DIR, { ...head, moves: 2 }, rows);
    const main = `${DIR}/00000000000000000003.manifest.jsonl`;
    const m = (await readManifest(app, DIR, main))!;
    expect([m.head.moves, m.head.more, m.rows]).toEqual([2, ["00000000000000000003.manifest-1.jsonl"], [["R/a.md", "ha", 6, 0], ["R/b.md", "hb", 6, 1]]]);
    expect(manifestFiles(DIR, main, m.head)).toEqual([main, `${DIR}/00000000000000000003.manifest-1.jsonl`, `${DIR}/00000000000000000003.part-0.jsonl`, `${DIR}/00000000000000000003.part-1.jsonl`]);
    expect(manifestFiles(DIR, main, null)).toEqual([main]);
    const file = (name: string) => path.join(dir, "transaction_log", "main.a.b", name);
    const text = fs.readFileSync(file("00000000000000000003.manifest.jsonl"), "utf8");
    const more = fs.readFileSync(file("00000000000000000003.manifest-1.jsonl"), "utf8");
    expect(await readManifest(app, DIR, `${DIR}/00000000000000000009.manifest.jsonl`)).toBeNull();
    for (const [main2, more2] of [
      ["", more],
      [text.replace('"format":2', '"format":3'), more],
      [text, null],
      [text.replace('"rows":2', '"rows":3'), more],
      [`${text}not json\n`, more],
    ] as const) {
      fs.writeFileSync(file("00000000000000000003.manifest.jsonl"), main2);
      if (more2 === null) fs.rmSync(file("00000000000000000003.manifest-1.jsonl"), { force: true });
      else fs.writeFileSync(file("00000000000000000003.manifest-1.jsonl"), more2);
      expect(await readManifest(app, DIR, main)).toBeNull();
    }
  });

  it("a manifest checkpoint whose part a crash lost, or whose manifest it tore, is written again", async () => {
    const dir = tmp();
    const app = storeApp(folderStore(dir));
    const main = `${DIR}/00000000000000000003.manifest.jsonl`;
    const file = (name: string) => path.join(dir, "transaction_log", "main.a.b", name);
    const whole = async () => {
      const m = await readManifest(app, DIR, main);
      expect(m?.rows.map((r) => r[0])).toEqual(["R/a.md", "R/b.md"]);
      expect(await readPart(app, DIR, m!.head.parts[0]!)).toEqual(new Map([["R/a.md", "text a"], ["R/b.md", "text b"]]));
    };
    await writeManifestCheckpoint(app, DIR, head, rows);
    await whole();
    fs.rmSync(file("00000000000000000003.part-0.jsonl"));
    expect(await writeManifestCheckpoint(app, DIR, head, rows)).toEqual([`${DIR}/00000000000000000003.part-0.jsonl`, main]);
    await whole();
    const text = fs.readFileSync(file("00000000000000000003.manifest.jsonl"), "utf8");
    fs.writeFileSync(file("00000000000000000003.manifest.jsonl"), text.slice(0, Math.floor(text.length / 2)));
    expect(await writeManifestCheckpoint(app, DIR, head, rows)).toEqual([`${DIR}/00000000000000000003.part-0.jsonl`, main]);
    await whole();
    // whole: kept
    expect(await writeManifestCheckpoint(app, DIR, head, rows)).toEqual([]);
  });

  it("parts missing or unreadable read as none; gzip ones read whole", async () => {
    const s = diskStore();
    await writeManifestCheckpoint(s.app, DIR, head, rows);
    expect(fs.readdirSync(path.dirname(s.file("x")))).toEqual(["00000000000000000003.manifest.jsonl", "00000000000000000003.part-0.jsonl.gz"]);
    expect(await readPart(s.app, DIR, "00000000000000000003.part-0.jsonl.gz")).toEqual(new Map([["R/a.md", "text a"], ["R/b.md", "text b"]]));
    expect(await readPart(s.app, DIR, "00000000000000000009.part-0.jsonl.gz")).toBeNull();
    expect(await readPart(s.app, DIR, "00000000000000000009.part-0.jsonl")).toBeNull();
    fs.writeFileSync(s.file("00000000000000000003.part-0.jsonl.gz"), "not gzip");
    expect(await readPart(s.app, DIR, "00000000000000000003.part-0.jsonl.gz")).toBeNull();
    fs.writeFileSync(s.file("00000000000000000004.part-0.jsonl"), "[not json\n");
    expect(await readPart(s.app, DIR, "00000000000000000004.part-0.jsonl")).toBeNull();
  });
});

describe("a torn segment on a store that tells sizes", () => {
  it("is cut back to its whole versions, and its size kept for the next append", async () => {
    const s = diskStore();
    await appendVersion(s.app, DIR, 0, version(0), "segments");
    const file = s.file("00000000000000000000.segment.jsonl");
    const whole = fs.readFileSync(file, "utf8");
    fs.appendFileSync(file, '{"commit":{"version":1,"lines":2}}\n{"commitInfo"');
    forgetLogTocs(s.app);
    expect(await appendVersion(s.app, DIR, 1, version(1), "segments")).toEqual([`${DIR}/00000000000000000000.segment.jsonl: 48 characters of a torn version cut`]);
    expect(fs.readFileSync(file, "utf8")).toBe(whole + framed(1, version(1)));
    expect((await logToc(s.app, DIR)).segments[0]!.bytes).toBe(fs.statSync(file).size);
  });
});
