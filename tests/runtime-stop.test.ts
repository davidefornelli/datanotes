import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeWithDefaults } from "../src/core/settings";
import { openNodeVault } from "../src/node/node-app";
import { EngineRuntime } from "../src/server/runtime";
import { LOG_YAML, METASTORE, TEST_DATABASE_FOLDER } from "./helpers/db-vault";

/** A started runtime on a vault on disk, as the service runs it. */
async function started() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-stop-"));
  fs.mkdirSync(path.join(root, "Datanotes"));
  fs.writeFileSync(path.join(root, METASTORE), LOG_YAML);
  const host = openNodeVault(root);
  const settings = mergeWithDefaults({ fileLogEnabled: false, autoRecompute: false, databaseFolder: TEST_DATABASE_FOLDER });
  const runtime = new EngineRuntime({
    app: host.app,
    getSettings: () => settings,
    saveSettings: async () => {},
    transport: async () => ({ status: 500, text: "" }),
    embeddingKey: () => undefined,
    version: "test",
    hostName: "test",
    canServeHttp: false,
  });
  await runtime.start({ http: false });
  // Background work is started by vault events and timers; the test hands it some directly.
  const track = (work: Promise<unknown>, what: string) => (runtime as unknown as { track(w: Promise<unknown>, what: string): void }).track(work, what);
  return { root, host, runtime, track };
}

describe("runtime stop", () => {
  it("waits for background work still running, so nothing touches the vault after stop", async () => {
    const { root, host, runtime, track } = await started();
    let done = false;
    track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          done = true;
          resolve();
        }, 300),
      ),
      "slow work",
    );
    await runtime.stop();
    expect(done).toBe(true);
    host.metadataCache.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("logs a failed background task instead of leaving an unhandled rejection, and still stops", async () => {
    const { root, host, runtime, track } = await started();
    track(Promise.reject(new Error("boom")), "failing work");
    await expect(runtime.stop()).resolves.toBeUndefined();
    host.metadataCache.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
