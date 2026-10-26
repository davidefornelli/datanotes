/**
 * A vault for the moves of the database folder at scale: a `day` table and a `task` table whose
 * generated link column `day_note` (`link({due:YYYY-MM-DD})`) names a day's note by its full path,
 * `tasks` rows, and plain notes that link into the database with full-path wikilinks, as a vault
 * synced from another tool has them. The tables are created through the engine (metastore.yaml
 * only changes through operations); the rows are written as copies of rows the engine wrote, so a
 * vault of 2000 rows is ready in seconds.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startService, type RunningService } from "../../src/node/service";
import { described } from "./descriptions";

export const TOKEN = "moved-vault-token";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * One call, on a connection of its own: the tests stop an engine and start another on the same
 * port, and a kept-alive connection to the stopped one would be reset (ECONNRESET) when reused.
 */
export function post(port: number, route: string, body: unknown = {}): Promise<{ status: number; json: Record<string, any> }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/datanotes/${route}`, method: "POST", agent: false, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, json: JSON.parse(text) as Record<string, any> });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

export interface MovedVault {
  root: string;
  port: number;
  settingsFile: string;
  /** The database folder the vault starts with. */
  folder: string;
  /** Row paths of the task table, vault-relative. */
  tasks: string[];
  /** Plain notes linking into the database. */
  notes: string[];
  start(o?: { watch?: "events" | "poll"; pollMs?: number; gitSync?: { intervalMs: number; quietMs: number; push: boolean } }): Promise<RunningService>;
}

const DAYS = 30;

/** Build the vault: `tasks` task rows over 30 days, a plain note per 10 tasks. The engine is stopped when it returns. */
export async function movedVault(tasks: number, folder = "Datanotes"): Promise<MovedVault> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moved-vault-"));
  const port = await freePort();
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moved-vault-settings-")), "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ httpServerPort: port, httpServerToken: TOKEN, fileLogEnabled: false }));
  const start: MovedVault["start"] = (o = {}) =>
    startService({ vault: root, watch: o.watch ?? "poll", pollMs: o.pollMs ?? 100, settingsFile, httpWaitMs: 10_000, ...(o.gitSync ? { gitSync: o.gitSync } : {}) }, {});
  const svc = await start();
  try {
    const ok = async (route: string, body: unknown) => {
      const r = await post(port, route, body);
      if (r.status !== 200 || r.json.ok === false) throw new Error(`${route}: ${JSON.stringify(r.json)}`);
      return r.json;
    };
    // a new database is datanotes/; the tests start from the folder they name (Datanotes/ as an older vault has it)
    await ok("operations/configure_database/", { history: true, ...(folder !== "datanotes" ? { root: folder } : {}) });
    await ok("operations/create_table/", described({ name: "day", columns: [{ name: "date", type: "date", required: true }], time_column: "date", filename: "{date:YYYY-MM-DD}" }));
    await ok("operations/create_table/", described({
      name: "task",
      columns: [
        { name: "title", type: "string", required: true },
        { name: "due", type: "date" },
        { name: "day_note", type: "link", ref: "main.public.day", generated: "link({due:YYYY-MM-DD})" },
      ],
      filename: "{title}",
    }));
    const day = (await ok("operations/insert_row/", { table: "day", values: { date: "2026-09-01" } })).planned_creates[0] as string;
    const task = (await ok("operations/insert_row/", { table: "task", values: { title: "task 0", due: "2026-09-01" } })).planned_creates[0] as string;
    const dayText = fs.readFileSync(path.join(root, day), "utf8");
    const taskText = fs.readFileSync(path.join(root, task), "utf8");
    const ids = (text: string) => [...text.matchAll(/^(id|_id): ?(.+)$/gm)].map((m) => m[2]!.trim());
    const fresh = (text: string) => ids(text).reduce((t, id) => t.split(id).join(crypto.randomUUID()), text);
    const dateOf = (i: number) => `2026-09-${String((i % DAYS) + 1).padStart(2, "0")}`;
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    for (let i = 1; i < DAYS; i++) put(day.replace("2026-09-01", dateOf(i)), fresh(dayText).split("2026-09-01").join(dateOf(i)));
    const out: string[] = [task];
    for (let i = 1; i < tasks; i++) {
      const rel = task.replace("task 0", `task ${i}`);
      put(rel, fresh(taskText).split("task 0").join(`task ${i}`).split("2026-09-01").join(dateOf(i)));
      out.push(rel);
    }
    const notes: string[] = [];
    for (let i = 0; i < Math.ceil(tasks / 10); i++) {
      const rel = `Notes/note ${i}.md`;
      const links = out.slice(i * 10, i * 10 + 10).map((p) => `- [[${p.replace(/\.md$/, "")}]]`);
      put(rel, `# Note ${i}\n\nSee [[${day.replace(/\.md$/, "")}]] and:\n${links.join("\n")}\n`);
      notes.push(rel);
    }
    await svc.stop();
    return { root, port, settingsFile, folder, tasks: out, notes, start };
  } catch (e) {
    await svc.stop();
    throw e;
  }
}
