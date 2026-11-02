/**
 * `POST /datanotes/restart/`: restart the engine in its own process, so the settings waiting for a
 * restart and the settings file's hand edits apply. With `{"dry_run": true}` it only says what a
 * restart would do and whether it can (the problems that would make the next start fail).
 *
 * Owner only (OWNER_ADMIN_ROUTES, and checked again here) and POST only (http-server.ts). The host
 * restarts (the service: runService in src/node/service.ts); this module only checks and answers.
 * The route is served only by a host that can restart.
 */

import { DEFAULT_SETTINGS, RUNTIME_KEYS, SETTING_RULES, type DatanotesSettings, type EditableSettingKey } from "../core/settings";
import { currentActor } from "../core/actor";
import { guide } from "../core/hints";
import { FORBIDDEN_HINT, type Handler, type HandlerResponse } from "./rest";
import { tokenNameOf } from "./tokens";

export type StartedBy = "systemd" | "container" | "terminal" | "unknown";
export interface RestartProblem {
  error: string;
  hint: string;
  docs: string;
}
/** What the host knows before a restart (the service: runService in src/node/service.ts). */
export interface HostRestartCheck {
  problems: RestartProblem[];
  /** The settings the next start reads, read now as it reads them; null when they cannot be read (a problem says why). */
  next: DatanotesSettings | null;
  portAfter: number;
  startedBy: StartedBy;
  restarting: boolean;
  lastCancelled?: { requested_at: string; reason: string };
}
export interface HostRestart {
  check(): Promise<HostRestartCheck>;
  /** Restart now: called once the answer is on its way. */
  restart(requestedAt: string): void;
}
export interface RestartDeps {
  host: HostRestart;
  /** The values this run started with (P1c's runningSettings). */
  running(): Partial<DatanotesSettings>;
  /** The settings object in memory now. */
  current(): DatanotesSettings;
  /** Settings a start option overrides: name -> the option in words (P1c's settingOverrides). */
  overrides(): Readonly<Record<string, string>>;
  startedAt(): string;
  port(): number | null;
  pid(): number | null;
  log(level: "INFO" | "WARN", message: string, attrs: Record<string, string>): void;
}

/**
 * What a restart would apply: the settings whose value at the next start differs from what runs
 * now, in settings order. Names only: the values (the owner token, the header values) are compared,
 * never returned.
 */
export function restartPlan(
  next: DatanotesSettings | null,
  running: Partial<DatanotesSettings>,
  current: DatanotesSettings,
  overrides: Readonly<Record<string, string>>,
): { will_apply: string[]; still_overridden: { setting: string; by: string }[]; warnings: string[] } {
  const will_apply: string[] = [];
  const still_overridden: { setting: string; by: string }[] = [];
  const warnings: string[] = [];
  if (next === null) return { will_apply, still_overridden, warnings };
  const runtimeKeys: readonly string[] = RUNTIME_KEYS;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (runtimeKeys.includes(key)) continue;
    const k = key as EditableSettingKey;
    const rule = SETTING_RULES[k];
    const now = rule.applies === "restart" && k in running ? running[k] : current[k];
    if (JSON.stringify(next[k]) === JSON.stringify(now)) continue;
    const by = overrides[k];
    if (by) {
      still_overridden.push({ setting: k, by });
      continue;
    }
    will_apply.push(k);
    const text = rule.fileOnly ?? rule.warning;
    if (text) warnings.push(`${k}: ${text}`);
  }
  return { will_apply, still_overridden, warnings };
}

const fail = (status: number, error: string, hint: string): HandlerResponse => ({ status, json: { error, ...guide(hint, "restartEngine") } });

export function restartHandler(deps: RestartDeps): Handler {
  return async (body) => {
    const name = tokenNameOf(currentActor());
    if (name) return { status: 403, json: { error: `token ${name} may not call /restart/ (reserved to the owner)`, ...FORBIDDEN_HINT } };
    // an empty POST has no body
    const raw: unknown = (body as unknown) ?? {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return fail(400, 'the body must be a JSON object, such as {"dry_run": true}', 'Send {} to restart, or {"dry_run": true} to see what a restart would do.');
    }
    const dryRunRaw = (raw as Record<string, unknown>).dry_run;
    if (dryRunRaw !== undefined && typeof dryRunRaw !== "boolean") {
      return fail(400, '"dry_run" must be true or false', 'Pass "dry_run": true to see what a restart would do, without restarting.');
    }
    const dry_run = dryRunRaw === true;
    const check = await deps.host.check();
    const plan = restartPlan(check.next, deps.running(), deps.current(), deps.overrides());
    const answer = {
      ok: true,
      dry_run,
      restarting: check.restarting,
      ready: check.problems.length === 0 && !check.restarting,
      problems: check.problems.map((p) => ({ error: p.error, hint: p.hint, docs: p.docs })),
      will_apply: plan.will_apply,
      still_overridden: plan.still_overridden,
      warnings: plan.warnings,
      port: deps.port(),
      port_after: check.portAfter,
      started_at: deps.startedAt(),
      pid: deps.pid(),
      started_by: check.startedBy,
      ...(check.lastCancelled ? { last_cancelled: { requested_at: check.lastCancelled.requested_at, reason: check.lastCancelled.reason } } : {}),
    };
    if (dry_run) return { status: 200, json: answer };
    if (check.restarting) {
      return fail(409, "the engine is already restarting", 'Wait until it is back (POST /datanotes/restart/ with "dry_run": true answers with a new started_at), then ask again.');
    }
    if (check.problems.length > 0) {
      const first = check.problems[0]!;
      return { status: 409, json: { error: first.error, hint: first.hint, docs: first.docs, problems: answer.problems } };
    }
    const requestedAt = new Date().toISOString();
    const actor = currentActor();
    deps.log("INFO", "datanotes restart requested over HTTP", {
      applies: plan.will_apply.join(", "),
      auth: actor?.auth ?? "owner",
      session: actor?.session ?? "",
      harness: actor?.harness ?? "",
    });
    // the answer leaves first, as /stop/'s: the drain must not wait for this very request
    setTimeout(() => deps.host.restart(requestedAt), 0);
    return { status: 200, json: { ...answer, restarting: true, ready: true, requested_at: requestedAt } };
  };
}
