/**
 * The Restart panel's logic (src/ui/lib/restart.ts, plan P8b, contract 3.0.5): the notes of a
 * restart, the failure texts and the waiter, with scripted fake dependencies.
 */

import { describe, expect, it, vi } from "vitest";
import { AuthRefused, EngineUnreachable } from "../src/ui/lib/api";
import { RESTART_TIMEOUT_MS, RETRY_AFTER_MS, failureText, retryOnce, restartNotes, waitForRestart, type RestartAnswer, type WaitDeps, type WaitPhase } from "../src/ui/lib/restart";

const PAGE = { protocol: "http:", hostname: "127.0.0.1" };
const L1 =
  "The engine restarts in its own process: it stops gracefully, then starts again with the same options. It is usually back within seconds, and within a minute when it pushes a backup.";
const L2 =
  'Requests under way finish first, for up to 30 seconds; if one is still running then, the restart is cancelled and nothing changes. Until the engine is back, agents and programs get "the engine is restarting" or no answer, and the change feed\'s clients reconnect.';

function answer(extra: Partial<RestartAnswer> = {}): RestartAnswer {
  return {
    ok: true,
    dry_run: true,
    restarting: false,
    ready: true,
    problems: [],
    will_apply: [],
    still_overridden: [],
    warnings: [],
    port: 27170,
    port_after: 27170,
    started_at: "2026-11-02T10:00:00.000Z",
    pid: 42,
    started_by: "terminal",
    ...extra,
  };
}

describe("restartNotes", () => {
  it("nothing to apply", () => {
    const n = restartNotes(answer(), PAGE);
    expect(n).toEqual({
      lines: [L1, L2, "No setting waits for a restart: the engine reads its settings file again."],
      warnings: [],
      failure: failureText("terminal"),
      newUrl: null,
      newToken: false,
      danger: false,
    });
  });
  it("will_apply, still_overridden and warnings", () => {
    const n = restartNotes(
      answer({ will_apply: ["vaultIndexEnabled", "storeBackupEnabled"], still_overridden: [{ setting: "httpServerPort", by: "the --port option" }], warnings: ["vaultIndexEnabled: W6"] }),
      PAGE,
    );
    expect(n.lines).toEqual([
      L1,
      L2,
      "It applies: vaultIndexEnabled, storeBackupEnabled.",
      "httpServerPort keeps its current value: the --port option wins over the setting.",
    ]);
    expect(n.warnings).toEqual(["vaultIndexEnabled: W6"]);
    expect(n.danger).toBe(false);
  });
  it("a port change", () => {
    const n = restartNotes(answer({ will_apply: ["httpServerPort"], port_after: 27180 }), PAGE);
    expect(n.newUrl).toBe("http://127.0.0.1:27180/datanotes/ui/");
    expect(n.lines[3]).toBe(
      "After the restart the engine answers on port 27180, so this page stops answering: open http://127.0.0.1:27180/datanotes/ui/. If you reach the engine through a proxy (tailscale serve, a reverse proxy) or a container's published port, point it at the new port first.",
    );
    expect(n.danger).toBe(true);
  });
  it("port null: no new address", () => {
    expect(restartNotes(answer({ port: null, port_after: 27180 }), PAGE).newUrl).toBeNull();
  });
  it("a new owner token", () => {
    const n = restartNotes(answer({ will_apply: ["httpServerToken"] }), PAGE);
    expect(n.newToken).toBe(true);
    expect(n.danger).toBe(true);
    expect(n.lines[3]).toBe("After the restart only the new owner token opens the engine: this page signs out, and every program that uses the owner token needs the new one.");
  });
});

describe("failureText", () => {
  it("the four kinds", () => {
    expect(failureText("systemd")).toBe(
      "If it cannot start again, it ends with exit code 1. systemd starts it again only if its unit says Restart=on-failure or Restart=always, and it then fails the same way until the cause is fixed; journalctl shows why.",
    );
    expect(failureText("container")).toBe(
      "If it cannot start again, it ends with exit code 1, and so does its container. Docker starts the container again only if its restart policy says so (the Datanotes compose file has restart: unless-stopped); docker logs shows why.",
    );
    expect(failureText("terminal")).toBe("If it cannot start again, it ends with exit code 1 and stays stopped: its terminal shows why, and you start it again there.");
    expect(failureText("unknown")).toBe(
      "If it cannot start again, it ends with exit code 1. Whatever started it decides whether it starts again; its console or log file shows why (datanotes status names the log file).",
    );
  });
});

type Step = { status: number; json: unknown } | "throw";

function fakes(steps: Step[], abortAt = Infinity): { deps: WaitDeps; phases: WaitPhase[]; elapsed: number[]; calls: () => number } {
  let t = 1000;
  let i = 0;
  let rounds = 0;
  const phases: WaitPhase[] = [];
  const elapsed: number[] = [];
  const deps: WaitDeps = {
    check: async () => {
      const s = steps[Math.min(i++, steps.length - 1)]!;
      if (s === "throw") throw new Error("connection refused");
      return s;
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    aborted: () => ++rounds >= abortAt,
    progress: (p, ms) => {
      phases.push(p);
      elapsed.push(ms);
    },
  };
  return { deps, phases, elapsed, calls: () => i };
}

const BEFORE = "2026-11-02T10:00:00.000Z";
const REQ = "2026-11-02T10:05:00.000Z";

describe("waitForRestart", () => {
  it("back after the old run, a 503 and nothing answering", async () => {
    const f = fakes([
      { status: 200, json: { started_at: BEFORE } },
      { status: 503, json: { error: "the engine is restarting" } },
      "throw",
      { status: 200, json: { started_at: "2026-11-02T10:05:03.000Z", restarting: false } },
    ]);
    expect(RESTART_TIMEOUT_MS).toBe(180_000);
    await expect(waitForRestart(f.deps, { before: BEFORE, requestedAt: REQ, newToken: false })).resolves.toEqual({ kind: "back", startedAt: "2026-11-02T10:05:03.000Z" });
    expect(f.phases).toEqual(["stopping", "stopping", "starting"]);
    expect(f.elapsed).toEqual([0, 1000, 2000]);
  });
  it("a new started_at while still restarting keeps waiting: the new engine answers before its start is finished", async () => {
    const f = fakes([
      { status: 200, json: { started_at: BEFORE, restarting: true } },
      { status: 200, json: { started_at: "2026-11-02T10:05:03.000Z", restarting: true } },
      { status: 200, json: { started_at: "2026-11-02T10:05:03.000Z" } },
      { status: 200, json: { started_at: "2026-11-02T10:05:03.000Z", restarting: false } },
    ]);
    await expect(waitForRestart(f.deps, { before: BEFORE, requestedAt: REQ, newToken: false })).resolves.toEqual({ kind: "back", startedAt: "2026-11-02T10:05:03.000Z" });
    expect(f.calls()).toBe(4);
    expect(f.phases).toEqual(["stopping", "stopping", "stopping"]);
  });
  it("cancelled for this restart; another cancel keeps waiting", async () => {
    const f = fakes([
      { status: 200, json: { started_at: BEFORE, last_cancelled: { requested_at: "2026-11-02T09:00:00.000Z", reason: "old" } } },
      { status: 200, json: { started_at: BEFORE, last_cancelled: { requested_at: REQ, reason: "a request ran longer than 30 s" } } },
    ]);
    await expect(waitForRestart(f.deps, { before: BEFORE, requestedAt: REQ, newToken: false })).resolves.toEqual({ kind: "cancelled", reason: "a request ran longer than 30 s" });
    expect(f.calls()).toBe(2);
  });
  it("401: new-token or refused", async () => {
    await expect(waitForRestart(fakes([{ status: 401, json: {} }]).deps, { before: BEFORE, requestedAt: REQ, newToken: true })).resolves.toEqual({ kind: "new-token" });
    await expect(waitForRestart(fakes([{ status: 401, json: {} }]).deps, { before: BEFORE, requestedAt: REQ, newToken: false })).resolves.toEqual({ kind: "refused" });
  });
  it("timeout", async () => {
    const f = fakes(["throw"]);
    await expect(waitForRestart(f.deps, { before: BEFORE, requestedAt: REQ, newToken: false, timeoutMs: 3000, everyMs: 1000 })).resolves.toEqual({ kind: "timeout" });
    expect(f.calls()).toBe(3);
  });
  it("aborted on the second round", async () => {
    const f = fakes(["throw"], 2);
    await expect(waitForRestart(f.deps, { before: BEFORE, requestedAt: REQ, newToken: false })).resolves.toEqual({ kind: "aborted" });
    expect(f.calls()).toBe(1);
  });
  it("a json that is not an object, an array, and a 200 without started_at keep waiting; no progress callback is fine", async () => {
    const f = fakes([
      { status: 200, json: "x" },
      { status: 200, json: null },
      { status: 200, json: [1] },
      { status: 200, json: {} },
      { status: 200, json: { started_at: "new", restarting: false } },
    ]);
    delete f.deps.progress;
    await expect(waitForRestart(f.deps, { before: BEFORE, requestedAt: REQ, newToken: false })).resolves.toEqual({ kind: "back", startedAt: "new" });
    expect(f.calls()).toBe(5);
  });
});

describe("retryOnce", () => {
  it("returns the first answer without sleeping", async () => {
    const f = vi.fn(async () => 1);
    const sleep = vi.fn(async () => {});
    await expect(retryOnce(f, sleep)).resolves.toBe(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("tries once more after RETRY_AFTER_MS when the engine did not answer", async () => {
    const f = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new EngineUnreachable("reset")).mockResolvedValueOnce(2);
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(retryOnce(f, sleep)).resolves.toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(RETRY_AFTER_MS);
    expect(RETRY_AFTER_MS).toBe(300);
  });

  it("throws the second failure", async () => {
    const f = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new EngineUnreachable("first")).mockRejectedValueOnce(new EngineUnreachable("second"));
    await expect(retryOnce(f, async () => {})).rejects.toThrow("second");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("throws any other error at once", async () => {
    const refused = new AuthRefused();
    const f = vi.fn<() => Promise<number>>().mockRejectedValueOnce(refused);
    const sleep = vi.fn(async () => {});
    await expect(retryOnce(f, sleep)).rejects.toBe(refused);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
