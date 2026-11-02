// The Restart panel's logic (plan P8b, D18, contract 3.0.5): what a restart does and applies, what a
// failed start means for the way the engine was started, and the wait until the engine is back.
// Pure: no DOM at import time; the waiter takes its clock, its sleep and its check as arguments.

import { EngineUnreachable } from "./api";

/** How the engine was started, as far as it can tell. */
export type StartedBy = "systemd" | "container" | "terminal" | "unknown";

/** Why the next start would fail. */
export interface RestartProblem {
  error: string;
  hint: string;
  docs: string;
}

/** The 200 answer of POST /datanotes/restart/ (contract 3.0.5). */
export interface RestartAnswer {
  ok: true;
  dry_run: boolean;
  restarting: boolean;
  ready: boolean;
  problems: RestartProblem[];
  will_apply: string[];
  still_overridden: { setting: string; by: string }[];
  warnings: string[];
  port: number | null;
  port_after: number;
  started_at: string;
  pid: number | null;
  started_by: StartedBy;
  last_cancelled?: { requested_at: string; reason: string };
  requested_at?: string;
}

/** window.location's parts the new address needs. */
export interface PageLocation {
  protocol: string;
  hostname: string;
}

export interface RestartNotes {
  /** What the restart does and applies. */
  lines: string[];
  /** answer.warnings as they are. */
  warnings: string[];
  /** failureText(answer.started_by) */
  failure: string;
  /** This page's address after a port change; null when the port stays. */
  newUrl: string | null;
  /** will_apply includes httpServerToken. */
  newToken: boolean;
  danger: boolean;
}

/** The line of a setting a start option keeps overriding. */
export function overriddenLine(o: { setting: string; by: string }): string {
  return `${o.setting} keeps its current value: ${o.by} wins over the setting.`;
}

/** What the panel and its confirmation say about a restart. */
export function restartNotes(a: RestartAnswer, page: PageLocation): RestartNotes {
  const newUrl = a.port !== null && a.port_after !== a.port ? `${page.protocol}//${page.hostname}:${a.port_after}/datanotes/ui/` : null;
  const newToken = a.will_apply.includes("httpServerToken");
  const lines = [
    "The engine restarts in its own process: it stops gracefully, then starts again with the same options. It is usually back within seconds, and within a minute when it pushes a backup.",
    'Requests under way finish first, for up to 30 seconds; if one is still running then, the restart is cancelled and nothing changes. Until the engine is back, agents and programs get "the engine is restarting" or no answer, and the change feed\'s clients reconnect.',
    a.will_apply.length > 0 ? `It applies: ${a.will_apply.join(", ")}.` : "No setting waits for a restart: the engine reads its settings file again.",
    ...a.still_overridden.map(overriddenLine),
  ];
  if (newUrl) {
    lines.push(
      `After the restart the engine answers on port ${a.port_after}, so this page stops answering: open ${newUrl}. If you reach the engine through a proxy (tailscale serve, a reverse proxy) or a container's published port, point it at the new port first.`,
    );
  }
  if (newToken) {
    lines.push("After the restart only the new owner token opens the engine: this page signs out, and every program that uses the owner token needs the new one.");
  }
  return { lines, warnings: [...a.warnings], failure: failureText(a.started_by), newUrl, newToken, danger: newUrl !== null || newToken };
}

/** What happens when the new start fails, for the way the engine was started. */
export function failureText(by: StartedBy): string {
  switch (by) {
    case "systemd":
      return "If it cannot start again, it ends with exit code 1. systemd starts it again only if its unit says Restart=on-failure or Restart=always, and it then fails the same way until the cause is fixed; journalctl shows why.";
    case "container":
      return "If it cannot start again, it ends with exit code 1, and so does its container. Docker starts the container again only if its restart policy says so (the Datanotes compose file has restart: unless-stopped); docker logs shows why.";
    case "terminal":
      return "If it cannot start again, it ends with exit code 1 and stays stopped: its terminal shows why, and you start it again there.";
    default:
      return "If it cannot start again, it ends with exit code 1. Whatever started it decides whether it starts again; its console or log file shows why (datanotes status names the log file).";
  }
}

export type WaitPhase = "stopping" | "starting";

export type WaitOutcome =
  | { kind: "back"; startedAt: string }
  | { kind: "new-token" }
  | { kind: "refused" }
  | { kind: "cancelled"; reason: string }
  | { kind: "timeout" }
  | { kind: "aborted" };

export interface WaitDeps {
  /** POST /datanotes/restart/ {dry_run: true} through plainApi; a 401 comes back as {status: 401}; throws when the engine does not answer. */
  check(): Promise<{ status: number; json: unknown }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  aborted(): boolean;
  progress?(phase: WaitPhase, elapsedMs: number): void;
}

export interface WaitOptions {
  /** started_at of the run that was asked to restart. */
  before: string;
  /** requested_at of the restart's answer. */
  requestedAt: string;
  newToken: boolean;
  timeoutMs?: number;
  everyMs?: number;
}

export const RESTART_TIMEOUT_MS = 180_000;

/** How long retryOnce waits before its second try. */
export const RETRY_AFTER_MS = 300;

/**
 * Calls `f`, and once more after RETRY_AFTER_MS when the engine did not answer: right after a
 * restart a request may go out on a keep-alive connection the old engine closed. Any other error,
 * and a second failure, are thrown.
 */
export async function retryOnce<T>(f: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!(e instanceof EngineUnreachable)) throw e;
    await sleep(RETRY_AFTER_MS);
    return f();
  }
}

/** Polls the dry run until the engine is back (a new started_at), refuses, cancels, or the time is up. */
export async function waitForRestart(deps: WaitDeps, o: WaitOptions): Promise<WaitOutcome> {
  const every = o.everyMs ?? 1000;
  const timeout = o.timeoutMs ?? RESTART_TIMEOUT_MS;
  const start = deps.now();
  for (;;) {
    if (deps.aborted()) return { kind: "aborted" };
    const elapsed = deps.now() - start;
    if (elapsed >= timeout) return { kind: "timeout" };
    let phase: WaitPhase = "stopping";
    let a: { status: number; json: unknown } | null = null;
    try {
      a = await deps.check();
    } catch {
      phase = "starting";
    }
    if (a) {
      const j = (typeof a.json === "object" && a.json !== null && !Array.isArray(a.json) ? a.json : {}) as {
        started_at?: unknown;
        last_cancelled?: { requested_at?: unknown; reason?: unknown };
      };
      if (a.status === 401) return o.newToken ? { kind: "new-token" } : { kind: "refused" };
      if (a.status === 200 && typeof j.started_at === "string" && j.started_at !== o.before) return { kind: "back", startedAt: j.started_at };
      if (a.status === 200 && j.last_cancelled?.requested_at === o.requestedAt) return { kind: "cancelled", reason: String(j.last_cancelled.reason) };
    }
    deps.progress?.(phase, elapsed);
    await deps.sleep(every);
  }
}
