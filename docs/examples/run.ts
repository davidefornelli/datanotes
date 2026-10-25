/**
 * Runs the examples of the docs site against a real engine: each chapter gets a new vault in a
 * temporary folder, `datanotes serve` on it (in process) and a `DatanotesClient`, and every step
 * is sent as an agent would send it. The pages show the answers the engine really gave, and a
 * step whose answer is not the expected one (`ok` or refused) fails the docs build and the
 * chapter's test (tests/examples/<slug>.test.ts).
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatanotesClient } from "../../src/api/client";
import { startService } from "../../src/node/service";
import { UNTIL_TIMEOUT_MS, type Chapter, type Ctx, type Step, type StepResult } from "./types";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChapterRun {
  chapter: Chapter;
  /** One entry per step of every example, in order. */
  results: StepResult[][];
}

export async function runChapter(chapter: Chapter): Promise<ChapterRun> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-example-"));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  for (const [rel, text] of Object.entries(chapter.files ?? {})) write(rel, text);
  const port = await freePort();
  const token = "example-token";
  // the engine's store: a temporary folder too, never the user's data folder
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "datanotes-example-store-"));
  fs.writeFileSync(path.join(store, "settings.json"), JSON.stringify({ httpServerPort: port, httpServerToken: token, fileLogEnabled: false, ...chapter.settings }));
  // A webhook receiver for the examples that push changes: it keeps what it is sent.
  const received: { headers: Record<string, unknown>; body: unknown }[] = [];
  const receiver = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ headers: { "x-datanotes-signature": req.headers["x-datanotes-signature"] }, body: JSON.parse(data || "null") });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  const hookUrl = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}/datanotes-hook`;
  const svc = await startService({ vault: root, store, watch: "poll", pollMs: 100, httpWaitMs: 10_000 }, {});
  const client = new DatanotesClient({ url: `http://127.0.0.1:${port}`, token, actor: { harness: "docs-example", session: chapter.slug } });
  const saved: Record<string, unknown> = { hookUrl };
  const ctx: Ctx = { saved, read, last: undefined };
  const results: StepResult[][] = [];
  try {
    const shownFile = (step: Step) => {
      const file = step.showFile ? (typeof step.showFile === "function" ? step.showFile(ctx) : step.showFile) : undefined;
      return file ? { file: { path: file, text: read(file) } } : {};
    };
    const run = async (step: Step, where: string): Promise<StepResult> => {
      if (step.edit) {
        const { path: rel, text } = step.edit;
        const next = typeof text === "function" ? text(read(rel)) : text;
        write(rel, next);
        await sleep(step.wait ?? 1500);
        return { step, ok: true, value: next };
      }
      if (step.move) {
        fs.mkdirSync(path.dirname(path.join(root, step.move.to)), { recursive: true });
        fs.renameSync(path.join(root, step.move.from), path.join(root, step.move.to));
        if (step.wait) await sleep(step.wait);
        return { step, ok: true, value: undefined };
      }
      if (step.age) {
        const at = new Date(step.age.at);
        const walk = (dir: string): string[] =>
          fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
        for (const rel of walk(step.age.folder)) fs.utimesSync(path.join(root, rel), at, at);
        await sleep(step.wait ?? 1500);
        return { step, ok: true, value: undefined };
      }
      if (step.received) {
        if (step.wait) await sleep(step.wait);
        if (received.length === 0) throw new Error(`${where}: the webhook receiver got nothing`);
        return { step, ok: true, value: received.at(-1) };
      }
      if (!step.op) {
        if (step.wait) await sleep(step.wait);
        return { step, ok: true, value: undefined, ...shownFile(step) };
      }
      const args = typeof step.args === "function" ? step.args(ctx) : (step.args ?? {});
      let r = await client.call(step.op!, args);
      if (step.until) {
        const deadline = Date.now() + UNTIL_TIMEOUT_MS;
        while (r.ok && !step.until(r.value, ctx)) {
          if (Date.now() > deadline) throw new Error(`${where}: ${step.op}: not there after ${UNTIL_TIMEOUT_MS} ms — got ${JSON.stringify(r.value).slice(0, 3000)}`);
          await sleep(100);
          r = await client.call(step.op!, args);
        }
      }
      const expected = step.refused ? false : true;
      if (r.ok !== expected) {
        throw new Error(`${where}: ${step.op} ${expected ? "was refused" : "was not refused"}: ${typeof r.value === "string" ? r.value : JSON.stringify(r.value).slice(0, 3000)}`);
      }
      if (step.check) {
        const problem = step.check(r.value, ctx);
        if (problem) throw new Error(`${where}: ${step.op}: ${problem} — got ${JSON.stringify(r.value).slice(0, 3000)}`);
      }
      ctx.last = r.value;
      if (step.save) saved[step.save] = r.value;
      if (step.wait) await sleep(step.wait);
      return { step, ok: r.ok, value: r.value, args, ...shownFile(step) };
    };
    for (const step of chapter.setup ?? []) await run(step, `${chapter.slug} (setup)`);
    for (const ex of chapter.examples) {
      const out: StepResult[] = [];
      for (const step of ex.steps) out.push(await run(step, `${chapter.slug} / ${ex.title}`));
      results.push(out);
    }
  } finally {
    await svc.stop();
    receiver.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
  return { chapter, results };
}
