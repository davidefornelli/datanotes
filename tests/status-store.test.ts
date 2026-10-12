/**
 * The engine's store in `datanotes status`: the route's report (the store, the database id, the
 * logs folder, the last move of the database folder), its text, and how the command finds the
 * store of a vault (--store, --database, the data home).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { engineStatus, type EngineStatus, type StatusInput } from "../src/server/status";
import { formatStatus, main, parseStatusArgs } from "../src/node/status";
import { logVault, type DbVault } from "./helpers/db-vault";

const ID = "0192e000-0000-7000-8000-000000000001";

function input(v: DbVault, over: Partial<StatusInput> = {}): StatusInput {
  return {
    app: v.app,
    settings: v.settings,
    version: "9.9.9",
    startedAt: new Date("2026-10-09T10:00:00Z"),
    now: new Date("2026-10-09T10:00:00Z"),
    http: { host: "127.0.0.1", port: 1234 },
    feed: null,
    feedProblem: null,
    webhooks: null,
    tokens: [],
    host: null,
    telemetryEndpoint: null,
    ...over,
  };
}

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe("the store in the status", () => {
  it("the route: the store and the logs folder of the host, the database id, and the last move of the database folder", async () => {
    const v = logVault();
    v.settings.databaseId = ID;
    v.write("store:database_moves.jsonl", `${JSON.stringify({ from: "Old", to: "Datanotes", at: "2026-10-09T08:00:00.000Z", by: "hand" })}\n`);
    const posix = await engineStatus(input(v, { host: { store: "/home/me/.local/share/datanotes/0192" } }));
    expect(posix.engine).toMatchObject({ store: "/home/me/.local/share/datanotes/0192", database_id: ID });
    expect(posix.logs.folder).toBe("/home/me/.local/share/datanotes/0192/logs");
    expect(posix.database.moved).toEqual({ from: "Old", to: "Datanotes", at: "2026-10-09T08:00:00.000Z", by: "hand" });
    const windows = await engineStatus(input(v, { host: { store: "C:\\Users\\me\\AppData\\Local\\Datanotes\\0192" } }));
    expect(windows.logs.folder).toBe("C:\\Users\\me\\AppData\\Local\\Datanotes\\0192\\logs");
    v.settings.databaseId = "";
    expect((await engineStatus(input(v))).engine).toMatchObject({ store: null, database_id: null });
  });

  it("the text: the move of the database folder, by hand or by configure_database", async () => {
    const v = logVault();
    const report = await engineStatus(input(v));
    const text = (moved: EngineStatus["database"]["moved"]) => formatStatus({ running: true, url: "http://x", ...report, database: { ...report.database, moved } });
    expect(text({ from: "A", to: "B", at: "t", by: "configure_database" })).toContain("moved      database folder A -> B at t (configure_database)\n");
    expect(text({ from: "A", to: "B", at: "t", by: "hand" })).toContain("moved      database folder A -> B at t (by hand)\n");
  });

  it("the command: --store finds a store named apart; the store found by the id otherwise", async () => {
    expect(parseStatusArgs(["--vault", "/v", "--store", "s"], {})).toEqual({ vault: path.resolve("/v"), store: path.resolve("s"), json: false });
    const v = logVault();
    const home = tmp("status-home-");
    const store = tmp("status-store-");
    fs.writeFileSync(path.join(store, "settings.json"), JSON.stringify({ httpServerToken: "t" }));
    let out = "";
    const env = { DATANOTES_DATA_HOME: home };
    expect(await main(["--vault", v.root, "--store", store, "--json"], { env, write: (t) => (out += t) })).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ settings: { file: path.join(store, "settings.json"), found: true, owner_token_set: true }, store: { path: store, database_id: null } });
    // no store found: no lock, no settings
    out = "";
    expect(await main(["--vault", v.root, "--json"], { env, write: (t) => (out += t) })).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ lock: { state: "none" }, settings: null, store: null });
    // a store found by the metastore's id, and its lock
    const meta = path.join(v.root, "Datanotes", "metastore.yaml");
    fs.writeFileSync(meta, `id: ${ID}\n${fs.readFileSync(meta, "utf8")}`);
    fs.mkdirSync(path.join(home, ID), { recursive: true });
    fs.writeFileSync(path.join(home, ID, "engine.lock"), JSON.stringify({ kind: "service", pid: 2, host: "store-host", port: 9, startedAt: "", heartbeat: new Date().toISOString() }));
    out = "";
    await main(["--vault", v.root], { env, write: (t) => (out += t) });
    expect(out).toContain(`store      ${path.join(home, ID)} (database id ${ID})\n`);
    expect(out).toContain("lock       other host (pid 2 on store-host");
    // the process environment by default
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["--vault", tmp("status-none-")])).toBe(2);
    } finally {
      write.mockRestore();
    }
  });
});
