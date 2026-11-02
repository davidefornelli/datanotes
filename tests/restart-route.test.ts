/**
 * `POST /datanotes/restart/` (src/server/restart-route.ts) with a fake host: what a restart would
 * apply, the answer's fields and order, the dry run, the refusals, and the restart asked once the
 * answer is on its way.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithActor } from "../src/core/actor";
import { DEFAULT_SETTINGS, SETTING_RULES, type DatanotesSettings } from "../src/core/settings";
import { restartHandler, restartPlan, type HostRestartCheck, type RestartDeps } from "../src/server/restart-route";
import type { Body } from "../src/server/rest";
import { guided } from "./helpers/guidance";

afterEach(() => {
  vi.useRealTimers();
});

const DOCS = "https://datanotes.dev/administration/run-the-service.md#restart-the-engine";
const FIELDS = ["ok", "dry_run", "restarting", "ready", "problems", "will_apply", "still_overridden", "warnings", "port", "port_after", "started_at", "pid", "started_by"];
const settings = (over: Partial<DatanotesSettings> = {}): DatanotesSettings => ({ ...structuredClone(DEFAULT_SETTINGS), ...over });

/** A fake host and the deps around it; `check` overrides what the host's check answers. */
function setup(check: Partial<HostRestartCheck> = {}) {
  const restarts: string[] = [];
  const logs: { level: string; message: string; attrs: Record<string, string> }[] = [];
  let checks = 0;
  const current = settings();
  const deps: RestartDeps = {
    host: {
      check: async () => {
        checks++;
        return { problems: [], next: settings(), portAfter: 27150, startedBy: "unknown", restarting: false, ...check };
      },
      restart: (at) => void restarts.push(at),
    },
    running: () => ({}),
    current: () => current,
    overrides: () => ({}),
    startedAt: () => "2026-11-02T10:00:00.000Z",
    port: () => 27150,
    pid: () => 4242,
    log: (level, message, attrs) => void logs.push({ level, message, attrs }),
  };
  const handler = restartHandler(deps);
  const call = (body: unknown, auth = "owner") => runWithActor({ auth }, () => handler(body as Body));
  return { call, handler, restarts, logs, checks: () => checks };
}

const json = (r: { json: unknown }) => r.json as Record<string, unknown>;

describe("restartPlan", () => {
  it("lists nothing when the next settings cannot be read", () => {
    expect(restartPlan(null, {}, settings(), {})).toEqual({ will_apply: [], still_overridden: [], warnings: [] });
  });

  it("lists a restart setting changed since the start, with its warning", () => {
    const plan = restartPlan(settings({ vaultIndexEnabled: false }), { vaultIndexEnabled: true }, settings({ vaultIndexEnabled: false }), {});
    expect(plan.will_apply).toEqual(["vaultIndexEnabled"]);
    expect(plan.warnings).toEqual([`vaultIndexEnabled: ${SETTING_RULES.vaultIndexEnabled.warning}`]);
  });

  it("lists a hand edit of a live setting", () => {
    expect(restartPlan(settings({ logRetentionDays: 9 }), {}, settings(), {}).will_apply).toEqual(["logRetentionDays"]);
  });

  it("puts a setting a start option overrides apart", () => {
    const by = "the --port option of datanotes serve (or DATANOTES_PORT)";
    const plan = restartPlan(settings({ httpServerPort: 28000 }), {}, settings(), { httpServerPort: by });
    expect(plan.still_overridden).toEqual([{ setting: "httpServerPort", by }]);
    expect(plan.will_apply).toEqual([]);
  });

  it("gives a file-only setting its reason as the warning", () => {
    const plan = restartPlan(settings({ tableKey: "kind" }), {}, settings(), {});
    expect(plan.warnings).toEqual([`tableKey: ${SETTING_RULES.tableKey.fileOnly}`]);
  });

  it("names a changed token, never its value, in settings order", () => {
    const plan = restartPlan(settings({ httpServerToken: "SENTINEL-NEW", logRetentionDays: 9, tableKey: "kind" }), {}, settings({ httpServerToken: "SENTINEL-OLD" }), {});
    expect(plan.will_apply).toEqual(["logRetentionDays", "tableKey", "httpServerToken"]);
    const text = JSON.stringify(plan);
    expect(text).not.toContain("SENTINEL-NEW");
    expect(text).not.toContain("SENTINEL-OLD");
  });
});

describe("POST /datanotes/restart/", () => {
  it("answers a dry run with every field in order, and restarts nothing", async () => {
    vi.useFakeTimers();
    const s = setup();
    const r = await s.call({ dry_run: true });
    expect(r.status).toBe(200);
    expect(Object.keys(json(r))).toEqual(FIELDS);
    expect(json(r)).toMatchObject({ ok: true, dry_run: true, restarting: false, ready: true, problems: [], port: 27150, port_after: 27150, pid: 4242, started_by: "unknown" });
    await vi.runAllTimersAsync();
    expect(s.restarts).toEqual([]);
  });

  it("restarts once the answer is on its way, and logs who asked", async () => {
    vi.useFakeTimers();
    const s = setup();
    const r = await s.call({});
    expect(r.status).toBe(200);
    const body = json(r);
    expect(Object.keys(body)).toEqual([...FIELDS, "requested_at"]);
    expect(body).toMatchObject({ dry_run: false, restarting: true, ready: true });
    expect(new Date(body.requested_at as string).toISOString()).toBe(body.requested_at);
    expect(s.restarts).toEqual([]);
    await vi.runAllTimersAsync();
    expect(s.restarts).toEqual([body.requested_at]);
    expect(s.logs).toEqual([{ level: "INFO", message: "datanotes restart requested over HTTP", attrs: { applies: "", auth: "owner", session: "", harness: "" } }]);
  });

  it("logs the agent's session and harness, and the owner when no actor is known", async () => {
    vi.useFakeTimers();
    const s = setup();
    await runWithActor({ auth: "owner", session: "s-1", harness: "claude-code" }, () => s.handler({}));
    expect(s.logs.at(-1)!.attrs).toEqual({ applies: "", auth: "owner", session: "s-1", harness: "claude-code" });
    const handler = restartHandler({
      host: { check: async () => ({ problems: [], next: null, portAfter: 1, startedBy: "terminal", restarting: false }), restart: () => undefined },
      running: () => ({}),
      current: () => settings(),
      overrides: () => ({}),
      startedAt: () => "x",
      port: () => null,
      pid: () => null,
      log: (_level, _message, attrs) => void s.logs.push({ level: "INFO", message: "", attrs }),
    });
    expect((await handler({})).status).toBe(200);
    expect(s.logs.at(-1)!.attrs.auth).toBe("owner");
    await vi.runAllTimersAsync();
  });

  it("refuses a restart the next start would fail, with every problem", async () => {
    vi.useFakeTimers();
    const problems = [
      { error: "first problem", hint: "fix it", docs: DOCS },
      { error: "second problem", hint: "fix that", docs: DOCS },
    ];
    const s = setup({ problems });
    const dry = await s.call({ dry_run: true });
    expect(json(dry)).toMatchObject({ ready: false, problems });
    const r = await s.call({});
    expect(r.status).toBe(409);
    expect(json(r)).toEqual({ error: "first problem", hint: "fix it", docs: DOCS, problems });
    await vi.runAllTimersAsync();
    expect(s.restarts).toEqual([]);
  });

  it("refuses a restart while one is under way", async () => {
    const s = setup({ restarting: true });
    expect(json(await s.call({ dry_run: true }))).toMatchObject({ ready: false, restarting: true });
    const r = await s.call({});
    expect(r.status).toBe(409);
    expect(json(r)).toEqual(guided("the engine is already restarting", { docs: DOCS }));
  });

  it("refuses a body that is not an object, or a dry_run that is not a boolean", async () => {
    vi.useFakeTimers();
    const s = setup();
    for (const body of [[], "x", 5, true]) {
      const r = await s.call(body);
      expect(r.status).toBe(400);
      expect(json(r)).toEqual(guided('the body must be a JSON object, such as {"dry_run": true}', { docs: DOCS }));
    }
    const r = await s.call({ dry_run: "yes" });
    expect(r.status).toBe(400);
    expect(json(r)).toEqual(guided('"dry_run" must be true or false', { docs: DOCS }));
    for (const body of [undefined, null]) {
      const ok = await s.call(body);
      expect(ok.status).toBe(200);
      expect(json(ok).dry_run).toBe(false);
    }
    await vi.runAllTimersAsync();
    expect(s.restarts).toHaveLength(2);
  });

  it("refuses a named token before it checks anything", async () => {
    const s = setup();
    const r = await s.call({ dry_run: true }, "cook");
    expect(r.status).toBe(403);
    expect(json(r)).toEqual(guided("token cook may not call /restart/ (reserved to the owner)"));
    expect(s.checks()).toBe(0);
  });

  it("passes the last cancelled restart through, and leaves it out otherwise", async () => {
    const lastCancelled = { requested_at: "2026-11-02T10:01:00.000Z", reason: "a request was still under way after 30 s" };
    const withIt = json(await setup({ lastCancelled }).call({ dry_run: true }));
    expect(withIt.last_cancelled).toEqual(lastCancelled);
    expect(Object.keys(withIt)).toEqual([...FIELDS, "last_cancelled"]);
    expect("last_cancelled" in json(await setup().call({ dry_run: true }))).toBe(false);
  });
});
