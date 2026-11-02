import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Button, ConfirmDialog, CopyField, ErrorBox, errorBodyOf, Spinner } from "../../components";
import { AuthRefused, type ErrorBody } from "../../lib/api";
import { overriddenLine, restartNotes, retryOnce, waitForRestart, type RestartAnswer, type RestartNotes, type RestartProblem, type WaitOutcome, type WaitPhase } from "../../lib/restart";
import { useApp } from "../../state";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CANNOT =
  "This engine cannot restart itself from here: it runs inside another program, or it is older than this page. Stop it and start it again: datanotes stop, then start it as you usually do.";

export interface RestartPanelProps {
  /** True while a restart runs: the screen disables its inputs, Check and Save. */
  busy(b: boolean): void;
  /** The engine is back: the screen loads the settings again. */
  onRestarted(): void;
  /** Changes after each save: the panel asks the engine again. */
  reloadKey: number;
}

type Load = { kind: "loading" } | { kind: "cannot" } | { kind: "error"; body: ErrorBody } | { kind: "ready"; answer: RestartAnswer; notes: RestartNotes };

interface Moved {
  port: number;
  url: string;
  newToken: boolean;
}

/** Restart the engine (D18, contract 3.0.5): what it applies, whether it can, the restart and the wait. */
export function RestartPanel(props: RestartPanelProps): JSX.Element {
  const { api, plainApi, bus, toast, catalog, signOut } = useApp();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ phase: WaitPhase; s: number } | null>(null);
  const [error, setError] = useState<{ body: ErrorBody; problems: RestartProblem[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState<{ before: string; requestedAt: string; notes: RestartNotes } | null>(null);
  const [moved, setMoved] = useState<Moved | null>(null);
  const mounted = useRef(true);
  const busy = useRef(props.busy);
  busy.current = props.busy;
  const onRestarted = useRef(props.onRestarted);
  onRestarted.current = props.onRestarted;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dryRun = useCallback(async () => {
    try {
      const a = await retryOnce(() => api.route<RestartAnswer>("/restart/", { dry_run: true }), pause);
      if (!mounted.current) return;
      if (a.status === 404) setLoad({ kind: "cannot" });
      else if (!a.ok) setLoad({ kind: "error", body: errorBodyOf(a.json) });
      else setLoad({ kind: "ready", answer: a.json, notes: restartNotes(a.json, window.location) });
    } catch (e) {
      if (mounted.current) setLoad({ kind: "error", body: errorBodyOf(e) });
    }
  }, [api]);

  useEffect(() => {
    void dryRun();
  }, [dryRun, props.reloadKey]);

  const wait = async (before: string, requestedAt: string, notes: RestartNotes) => {
    setRunning(true);
    busy.current(true);
    setTimedOut(null);
    setMessage(null);
    setProgress(null);
    let outcome: WaitOutcome;
    try {
      outcome = await waitForRestart(
        {
          check: async () => {
            try {
              const a = await plainApi.route("/restart/", { dry_run: true });
              return { status: a.status, json: a.json };
            } catch (e) {
              if (e instanceof AuthRefused) return { status: 401, json: {} };
              throw e;
            }
          },
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: Date.now,
          aborted: () => !mounted.current,
          progress: (phase, ms) => setProgress({ phase, s: Math.round(ms / 1000) }),
        },
        { before, requestedAt, newToken: notes.newToken },
      );
    } finally {
      busy.current(false);
    }
    if (outcome.kind === "aborted") return;
    setRunning(false);
    setProgress(null);
    switch (outcome.kind) {
      case "back":
        toast({ text: "The engine restarted", kind: "ok" });
        onRestarted.current();
        void retryOnce(() => catalog.refresh(), pause).catch(() => {});
        void dryRun();
        break;
      case "new-token":
        signOut("new-token");
        break;
      case "refused":
        signOut("refused");
        break;
      case "cancelled":
        setMessage(`The restart was cancelled: ${outcome.reason}. The engine goes on with its current settings; try again once the long requests are over.`);
        void dryRun();
        break;
      case "timeout":
        setTimedOut({ before, requestedAt, notes });
        break;
    }
  };

  const restart = async (answer: RestartAnswer, notes: RestartNotes) => {
    setConfirming(false);
    setError(null);
    setMessage(null);
    let a;
    try {
      a = await api.route<RestartAnswer & { error?: string; problems?: RestartProblem[] }>("/restart/", { dry_run: false });
    } catch (e) {
      setError({ body: errorBodyOf(e), problems: [] });
      return;
    }
    if (a.status !== 200) {
      setError({ body: errorBodyOf(a.json), problems: a.status === 409 && Array.isArray(a.json.problems) ? a.json.problems : [] });
      if (a.status === 409) void dryRun();
      return;
    }
    if (notes.newUrl || notes.newToken) bus.stop();
    if (notes.newUrl) {
      setMoved({ port: answer.port_after, url: notes.newUrl, newToken: notes.newToken });
      return;
    }
    await wait(a.json.started_at, a.json.requested_at ?? "", notes);
  };

  if (moved) {
    return (
      <section class="settings-restart">
        <h2>Restart the engine</h2>
        <p>The engine is restarting on port {moved.port}. This page stops answering: open the new address.</p>
        <CopyField value={moved.url} />
        {moved.newToken ? <p>Sign in there with the new owner token.</p> : null}
      </section>
    );
  }

  return (
    <section class="settings-restart">
      <h2>Restart the engine</h2>
      {load.kind === "loading" ? <Spinner /> : null}
      {load.kind === "cannot" ? <p>{CANNOT}</p> : null}
      {load.kind === "error" ? <ErrorBox body={load.body} /> : null}
      {load.kind === "ready" ? (
        <>
          <p>{load.answer.will_apply.length > 0 ? `Waiting for a restart: ${load.answer.will_apply.join(", ")}.` : "No setting waits for a restart."}</p>
          {load.answer.still_overridden.map((o) => (
            <p key={o.setting}>{overriddenLine(o)}</p>
          ))}
          {load.answer.restarting ? <p>A restart is under way.</p> : null}
          {load.answer.problems.map((p, i) => (
            <ErrorBox key={i} body={p} />
          ))}
          {load.answer.last_cancelled ? <p class="settings-info">The last restart was cancelled: {load.answer.last_cancelled.reason}.</p> : null}
          {running ? (
            <p class="settings-progress">
              <Spinner />{" "}
              {progress?.phase === "starting"
                ? `Restarting the engine: starting again (${progress.s} s)`
                : `Restarting the engine: requests under way finish (${progress?.s ?? 0} s)`}
            </p>
          ) : (
            <Button kind={load.notes.danger ? "danger" : "primary"} disabled={!load.answer.ready} onClick={() => setConfirming(true)}>
              Restart the engine…
            </Button>
          )}
          {confirming ? (
            <ConfirmDialog
              title="Restart the engine"
              confirmLabel="Restart now"
              danger={load.notes.danger}
              message={
                <>
                  <ul>
                    {load.notes.lines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  {load.notes.warnings.length > 0 ? (
                    <>
                      <p>
                        <strong>Warnings</strong>
                      </p>
                      <ul>
                        {load.notes.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <p>{load.notes.failure}</p>
                </>
              }
              onCancel={() => setConfirming(false)}
              onConfirm={() => void restart(load.answer, load.notes)}
            />
          ) : null}
        </>
      ) : null}
      {error ? (
        <>
          <ErrorBox body={error.body} />
          {error.problems.map((p, i) => (
            <ErrorBox key={i} body={p} />
          ))}
        </>
      ) : null}
      {message ? <p class="settings-info">{message}</p> : null}
      {timedOut ? (
        <div class="settings-warning">
          <p>The engine has not come back after 3 minutes.</p>
          <p>{timedOut.notes.failure}</p>
          <Button onClick={() => void wait(timedOut.before, timedOut.requestedAt, timedOut.notes)}>Keep waiting</Button>
        </div>
      ) : null}
    </section>
  );
}
