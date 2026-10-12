/**
 * `datanotes stop`: a graceful stop of the engine running on a vault.
 *
 *   datanotes stop --vault <folder> [--store <folder>] [--settings <file>] [--timeout-s 60] [--json]
 *   datanotes stop --url <url> --token <token> [--timeout-s 60] [--json]
 *
 * (or DATANOTES_DATABASE / DATANOTES_VAULT, DATANOTES_SETTINGS, DATANOTES_URL, DATANOTES_TOKEN).
 *
 * The engine is found as `datanotes status` finds it: the lock in its store (pid, host, port) and
 * the owner's token in its settings. The command asks it to stop (`POST /datanotes/stop/`):
 * the engine answers at once, lets the requests under way finish, makes its last git sync and store
 * backup commit and push, releases the lock and exits. The command waits for the engine's process
 * to end (with --url: for the address to stop answering), at most --timeout-s seconds.
 *
 * Exit codes: 0 stopped; 1 not stopped (not answering, or still running after the timeout: a stop
 * script then stops it by force); 2 no engine running on the vault; 3 the stop could not be asked
 * (another machine, still starting, token refused).
 */

import path from "node:path";
import { folderArg, readOptions, type OptionSpec } from "../api/cli-options";
import { localEngine, type EngineLock } from "../api/local";
import { guide, GuidedError } from "../core/hints";
import { messageOf } from "../core/message";

export interface StopOptions {
  vault?: string;
  /** `--store`: the store folder itself (else DATANOTES_STORE, else found by the database's id). */
  store?: string;
  settingsFile?: string;
  url?: string;
  token?: string;
  /** How long to wait for the engine to end, ms. */
  timeoutMs: number;
  json: boolean;
  /** The environment the store is found with (DATANOTES_DATA_HOME, DATANOTES_STORE...). */
  env?: Record<string, string | undefined>;
}

export const EXIT_STOPPED = 0;
export const EXIT_NOT_STOPPED = 1;
export const EXIT_NOT_RUNNING = 2;
/** The stop could not be asked: the engine is on another machine, still starting, or refuses the request. */
export const EXIT_NOT_ASKED = 3;

/** The default wait for the engine to end, in seconds. */
export const DEFAULT_TIMEOUT_S = 60;

/** The options of `datanotes stop`. */
export const STOP_OPTIONS: OptionSpec = { values: ["vault", "database", "settings", "store", "url", "token", "timeout-s"], flags: ["json"] };

export function parseStopArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): StopOptions {
  const o = readOptions(argv, STOP_OPTIONS, "datanotes stop");
  const get = (name: string) => o.get(name);
  const vault = folderArg(o, env, "datanotes stop", false)?.folder;
  const settingsFile = get("settings") ?? env.DATANOTES_SETTINGS;
  const store = get("store");
  const url = get("url") ?? env.DATANOTES_URL;
  const token = get("token") ?? env.DATANOTES_TOKEN;
  if (!vault && !(url && token)) throw new Error("pass --database <folder> (or --vault <folder>, DATANOTES_DATABASE, DATANOTES_VAULT), or --url and --token");
  const raw = get("timeout-s");
  const seconds = raw === undefined ? DEFAULT_TIMEOUT_S : /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(seconds)) {
    throw new GuidedError(`--timeout-s must be a number of seconds: "${raw}"`, guide(`Pass --timeout-s ${DEFAULT_TIMEOUT_S} (the default), the seconds to wait for the engine to finish and exit.`, "stop"));
  }
  return {
    ...(vault ? { vault: path.resolve(vault) } : {}),
    ...(settingsFile ? { settingsFile: path.resolve(settingsFile) } : {}),
    ...(store ? { store: path.resolve(store) } : {}),
    ...(url ? { url: url.replace(/\/+$/, "") } : {}),
    ...(token ? { token } : {}),
    timeoutMs: seconds * 1000,
    json: o.has("json"),
  };
}

export interface StopReport {
  stopped: boolean;
  /** The engine's address, when one was found. */
  url: string | null;
  /** The engine's process, when known. */
  pid: number | null;
  /** How long the stop took (or how long it was waited for). */
  seconds: number;
  /** What happened, in words. */
  message: string;
  /** What to do when it did not stop. */
  hint?: string;
}

export interface StopDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Is this process of this machine running? */
  alive?: (pid: number) => boolean;
  /** How often the end is checked, ms. */
  pollMs?: number;
}

/** Is a process with this pid running on this machine? */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * How to end a process that does not stop by itself: datanotes stop again first (the engine
 * finishes its write), SIGTERM next (handled the same way), the hard kill last. A kill during a
 * write can leave it half applied: notes are written before the journal records them.
 */
function forceHint(pid: number | null): string {
  const p = pid === null ? "<pid>" : String(pid);
  return (
    `Run datanotes stop again with a longer --timeout-s: the engine finishes its write, then stops. Outside Windows, kill ${p} (SIGTERM) stops it the same way. ` +
    `Force it (Stop-Process -Id ${p} -Force on Windows, kill -9 ${p} elsewhere) only as a last resort: a write it interrupts may stay half applied and outside the journal (run check_table after the next start), and its last git sync and store backup push are skipped (the next start makes them).`
  );
}

/** Ask the engine to stop and wait for it: the report and the exit code (nothing printed). */
export async function stopEngine(o: StopOptions, deps: StopDeps = {}): Promise<{ code: number; report: StopReport }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = deps.alive ?? processAlive;
  const call = deps.fetch ?? fetch;
  const started = now();
  const seconds = () => Math.round((now() - started) / 100) / 10;
  const done = (code: number, r: Omit<StopReport, "seconds">) => ({ code, report: { ...r, seconds: seconds() } });

  let url = o.url ?? null;
  let token = o.token ?? "";
  let lock: EngineLock | null = null;
  if (o.vault && (!url || !token)) {
    let found: ReturnType<typeof localEngine>;
    try {
      found = localEngine(o.vault, { ...(o.env ? { env: o.env } : {}), ...(o.store ? { store: o.store } : {}), ...(o.settingsFile ? { settingsFile: o.settingsFile } : {}) });
    } catch (e) {
      // held on another machine: only that machine (or its address) can stop it
      return done(EXIT_NOT_ASKED, { stopped: false, url: null, pid: null, message: messageOf(e), hint: "Run datanotes stop on that machine, or pass the engine's --url and --token." });
    }
    if (!found) return done(EXIT_NOT_RUNNING, { stopped: false, url: null, pid: null, message: "no engine runs on the vault (no lock held, or no owner token in the settings)" });
    lock = found.lock;
    if (lock.port === 0) {
      return done(EXIT_NOT_ASKED, { stopped: false, url: null, pid: lock.pid, message: `the engine (pid ${lock.pid}) is starting: its HTTP server does not listen yet`, hint: "Run datanotes stop again in a moment." });
    }
    url ??= found.url;
    if (!token) token = found.token;
  }
  // parseStopArgs asks for --vault unless --url and --token are given
  const base = url!;
  // found through its lock: an engine of this machine (localEngine refuses another's), whose
  // process can be watched; at an address only, the engine may be on another machine (no pid)
  const pid = lock?.pid ?? null;

  let res: Response;
  try {
    res = await call(`${base}/datanotes/stop/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? messageOf(e);
    if (pid !== null && alive(pid)) {
      return done(EXIT_NOT_STOPPED, { stopped: false, url: base, pid, message: `the engine (pid ${pid}) does not answer at ${base} (${cause})`, hint: forceHint(pid) });
    }
    return done(EXIT_NOT_RUNNING, { stopped: false, url: base, pid, message: `nothing answers at ${base} (${cause})` });
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // 503: it is stopping already (another stop, a signal): wait for it all the same
  if (res.status !== 200 && res.status !== 503) {
    const why =
      res.status === 401
        ? "the token was refused (401): stop needs the owner's token"
        : res.status === 403
          ? "a named token cannot stop the engine (403): it needs the owner's token"
          : res.status === 404
            ? "this engine cannot stop on request (404): it is older than datanotes stop"
            : `HTTP ${res.status}${typeof body.error === "string" ? `: ${body.error}` : ""}`;
    const hint = res.status === 404 ? "Stop it with Ctrl+C or a signal (SIGINT, SIGTERM). Force it only as a last resort: a write it interrupts may stay half applied (run check_table after the next start)." : res.status === 401 || res.status === 403 ? "Pass the owner's token (httpServerToken in settings.json in the store: datanotes store path shows where)." : forceHint(pid);
    return done(EXIT_NOT_ASKED, { stopped: false, url: base, pid, message: why, hint });
  }

  // the end: the process is gone (this machine), else the address no longer answers
  const ended = async (): Promise<boolean> => {
    if (pid !== null) return !alive(pid);
    try {
      await call(`${base}/`, { signal: AbortSignal.timeout(2_000) });
      return false;
    } catch {
      return true;
    }
  };
  const deadline = started + o.timeoutMs;
  for (;;) {
    if (await ended()) {
      return done(EXIT_STOPPED, { stopped: true, url: base, pid, message: `the engine${pid !== null ? ` (pid ${pid})` : ""} stopped` });
    }
    if (now() >= deadline) break;
    await sleep(Math.min(deps.pollMs ?? 200, Math.max(0, deadline - now())));
  }
  return done(EXIT_NOT_STOPPED, {
    stopped: false,
    url: base,
    pid,
    message: `the engine${pid !== null ? ` (pid ${pid})` : ""} still runs after ${Math.round(o.timeoutMs / 1000)} s: it may be finishing a long write or a git push`,
    hint: forceHint(pid),
  });
}

/** The report for a person: one line, and what to do when the engine did not stop. */
export function formatStop(r: StopReport): string {
  // a stopped engine was always reached at an address
  const head = r.stopped ? `datanotes stop: ${r.message} in ${r.seconds} s (${r.url})` : `datanotes stop: ${r.message}`;
  return r.hint ? `${head}\n${r.hint}` : head;
}

/** `datanotes stop` (the command line is in `cli.ts`): prints the report, returns the exit code. */
export async function main(argv: string[], deps: StopDeps & { env?: NodeJS.ProcessEnv; write?: (text: string) => void } = {}): Promise<number> {
  const o = { ...parseStopArgs(argv, deps.env), ...(deps.env ? { env: deps.env } : {}) };
  const { code, report } = await stopEngine(o, deps);
  (deps.write ?? ((t) => process.stdout.write(t)))(`${o.json ? JSON.stringify({ exit_code: code, ...report }, null, 2) : formatStop(report)}\n`);
  return code;
}
