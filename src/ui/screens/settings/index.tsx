// The engine settings screen (plan P8b, D17, contract 3.0.4) and its Restart panel (D18, 3.0.5).
// Owner only: app.tsx refuses others. The draft holds only the user's edits; it never goes into a
// URL, the console, a toast or rendered JSON, and secrets appear only inside their password inputs.
import "./settings.css";
import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { Button, ConfirmDialog, CopyField, ErrorBox, errorBodyOf, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { retryOnce } from "../../lib/restart";
import { href, type Route } from "../../lib/router";
import { confirmationFor, rebase, refusedByName, setDraft, type Draft, type SettingsAnswer, type SettingsUpdateAnswer, type SettingView } from "../../lib/settings-form";
import { useApp } from "../../state";
import { RecentChanges } from "./RecentChanges";
import { RestartPanel } from "./RestartPanel";
import { SettingsTable } from "./SettingsTable";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DOCS = "https://datanotes.dev/reference/settings/";
const STALE = "the settings changed since you read them";
const ON_DISK = "the settings file changed on disk";

type Result = { kind: "check"; answer: SettingsUpdateAnswer } | { kind: "saved"; answer: SettingsUpdateAnswer };

export function SettingsScreen(_props: { route: Route }): JSX.Element {
  const { api, toast } = useApp();
  const [loaded, setLoaded] = useState<SettingsAnswer | null>(null);
  const [loadError, setLoadError] = useState<ErrorBody | null>(null);
  const [draft, setDraftState] = useState<Draft>({});
  const [resetKey, setResetKey] = useState(0);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [error, setError] = useState<ErrorBody | null>(null);
  const [conflict, setConflict] = useState(false);
  const [dropped, setDropped] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [confirm, setConfirm] = useState<{ warnings: string[]; requireText: string | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const fetchSettings = useCallback(async (): Promise<SettingsAnswer | null> => {
    try {
      const a = await retryOnce(() => api.route<SettingsAnswer>("/settings/", {}), pause);
      if (a.ok) return a.json;
      setLoadError(errorBodyOf(a.json));
    } catch (e) {
      setLoadError(errorBodyOf(e));
    }
    return null;
  }, [api]);

  const reload = useCallback(async () => {
    const s = await fetchSettings();
    if (s) {
      setLoadError(null);
      setLoaded(s);
      setResetKey((k) => k + 1);
    }
    return s;
  }, [fetchSettings]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError && !loaded) return <ErrorBox body={loadError} />;
  if (!loaded) return <Spinner />;

  const views = loaded.settings;
  const names = Object.keys(draft);
  const ordered = views.filter((v) => names.includes(v.name)).map((v) => v.name);
  const disabled = restarting || sending;
  const blocked = loaded.file_changed_on_disk;

  const onValue = (v: SettingView, value: unknown) => {
    setDraftState((d) => setDraft(d, v, value));
    setResult(null);
  };
  const onRaw = (name: string, value: unknown) => {
    setDraftState((d) => {
      const next = { ...d };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
    setResult(null);
  };

  const discard = () => {
    setDraftState({});
    setRefused({});
    setError(null);
    setResult(null);
    setDropped([]);
    setResetKey((k) => k + 1);
  };

  const send = async (dryRun: boolean) => {
    setSending(true);
    setError(null);
    setRefused({});
    setResult(null);
    try {
      const a = await api.route<SettingsUpdateAnswer & ErrorBody>("/settings/update/", { expect_version: loaded.settings_version, changes: draft, dry_run: dryRun });
      if (a.status === 200) {
        if (dryRun) {
          setResult({ kind: "check", answer: a.json });
          return;
        }
        const u = a.json;
        toast({ text: `Saved: ${u.applied_now.length} apply at once, ${u.after_restart.length} after a restart`, kind: "ok" });
        setLoaded({ settings_file: loaded.settings_file, file_changed_on_disk: loaded.file_changed_on_disk, settings_version: u.settings_version, restart_pending: u.restart_pending, settings: u.settings });
        setDraftState({});
        setDropped([]);
        setResetKey((k) => k + 1);
        setResult({ kind: "saved", answer: u });
        setReloadKey((k) => k + 1);
        return;
      }
      const body = errorBodyOf(a.json);
      if (a.status === 400) {
        setError(body);
        setRefused(refusedByName(a.json));
      } else if (a.status === 409 && body.error.startsWith(STALE)) {
        setConflict(true);
      } else if (a.status === 409 && body.error.startsWith(ON_DISK)) {
        setError(body);
        await reload();
      } else {
        setError(body);
      }
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setSending(false);
    }
  };

  const save = () => {
    const c = confirmationFor(views, draft);
    if (c.warnings.length > 0 || c.requireText !== null) setConfirm(c);
    else void send(false);
  };

  const keepEdits = async () => {
    const before = loaded.settings;
    const s = await reload();
    if (!s) return;
    const r = rebase(before, s.settings, draft);
    setDraftState(r.draft);
    setDropped(r.dropped);
    setConflict(false);
  };
  const dropEdits = async () => {
    discard();
    setConflict(false);
    await reload();
  };

  return (
    <div class="settings-screen">
      <h1>Engine settings</h1>
      <div class="settings-file">
        <span>Settings file:</span> {loaded.settings_file ? <CopyField value={loaded.settings_file} /> : <span class="ui-muted">kept in memory by this host</span>}
      </div>
      <p class="settings-links">
        <a href={DOCS} target="_blank" rel="noopener noreferrer">
          Every setting explained
        </a>{" "}
        · <a href={href("journal", {}, { op: "set_engine_settings" })}>Changes of the settings</a>
      </p>

      {blocked ? (
        <p class="settings-warning">
          The settings file was edited on disk while the engine runs. The engine reads those edits at its next start; until then this page cannot save. Restart the engine (below) to apply them.
        </p>
      ) : null}
      {loaded.restart_pending.length > 0 ? (
        <p class="settings-info">Waiting for a restart: {loaded.restart_pending.join(", ")}. Restart the engine (below) to apply them.</p>
      ) : null}

      <RestartPanel
        busy={setRestarting}
        reloadKey={reloadKey}
        onRestarted={() => {
          void reload();
          setReloadKey((k) => k + 1);
        }}
      />

      {conflict ? (
        <div class="settings-warning">
          <p>Someone changed the settings since you opened this page.</p>
          <Button kind="primary" onClick={() => void keepEdits()}>
            Reload and keep my edits
          </Button>{" "}
          <Button onClick={() => void dropEdits()}>Discard my edits</Button>
        </div>
      ) : null}
      {dropped.length > 0 ? <p class="settings-info">Changed meanwhile, your edit was dropped: {dropped.join(", ")}</p> : null}
      {loadError ? <ErrorBox body={loadError} /> : null}

      <SettingsTable settings={views} draft={draft} refused={refused} disabled={disabled} resetKey={resetKey} onValue={onValue} onRaw={onRaw} />

      {result ? <ResultBox result={result} /> : null}
      {error ? <ErrorBox body={error} /> : null}

      {names.length > 0 ? (
        <div class="settings-footer">
          <span>
            {names.length} change{names.length === 1 ? "" : "s"}: {ordered.concat(names.filter((n) => !ordered.includes(n))).join(", ")}
          </span>
          <span class="settings-footer-buttons">
            <Button disabled={disabled} onClick={discard}>
              Discard
            </Button>
            <Button disabled={disabled || blocked} onClick={() => void send(true)}>
              Check
            </Button>
            <Button kind="primary" disabled={disabled || blocked} onClick={save}>
              Save
            </Button>
          </span>
        </div>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title="Change the engine's settings"
          confirmLabel="Save"
          danger={confirm.requireText !== null}
          {...(confirm.requireText !== null ? { requireText: confirm.requireText } : {})}
          message={
            <>
              {confirm.warnings.length > 0 ? (
                <ul>
                  {confirm.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
              {confirm.requireText !== null ? <p>Type the host that will receive data: {confirm.requireText}</p> : null}
            </>
          }
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void send(false);
          }}
        />
      ) : null}

      <RecentChanges reloadKey={reloadKey} />
    </div>
  );
}

function ResultBox(props: { result: Result }): JSX.Element {
  const a = props.result.answer;
  return (
    <div class="settings-info settings-result">
      {props.result.kind === "check" ? <p>Check only: nothing was saved.</p> : null}
      {props.result.kind === "check" && a.changed.length === 0 ? <p>Nothing would change.</p> : null}
      {a.applied_now.length > 0 ? <p>Applies at once: {a.applied_now.join(", ")}</p> : null}
      {a.after_restart.length > 0 ? <p>After a restart: {a.after_restart.join(", ")}</p> : null}
      {a.follow_ups.length > 0 ? (
        <ul>
          {a.follow_ups.map((f) => (
            <li key={f.setting}>
              {f.description}
              {f.setting.startsWith("semantic") ? (
                <>
                  {" "}
                  <a href={href("semantic")}>Semantic index</a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
