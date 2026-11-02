import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, ConfirmDialog, ErrorBox, errorBodyOf, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { undoable } from "../../lib/format";
import type { Route } from "../../lib/router";
import { href } from "../../lib/router";
import { useApp } from "../../state";
import { useLoad } from "./use-load";

interface Described {
  root?: string;
  config?: Record<string, unknown>;
}

const TEXT = ["root", "default_catalog", "default_schema", "default_partition", "default_filename", "archive_folder", "timezone"] as const;
const FLAGS = ["history", "autolink"] as const;
type Form = Record<(typeof TEXT)[number] | (typeof FLAGS)[number], string>;

const HELP: Record<string, string> = {
  root: "The database folder in the vault.",
  default_catalog: "The catalog new tables go to.",
  default_schema: "The schema new tables go to.",
  default_partition: "Date format of row sub-folders; empty means flat.",
  default_filename: "Date format of row file names.",
  archive_folder: "Where deleted notes are kept.",
  timezone: "An IANA time zone; empty stores values as given.",
  history: "Every table keeps a transaction log (time travel) by default.",
  autolink: "A write links the notes its text mentions by name.",
};

function formOf(d: Described): Form {
  const c = d.config ?? {};
  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  return {
    root: s(d.root ?? c.root),
    default_catalog: s(c.default_catalog),
    default_schema: s(c.default_schema),
    default_partition: s(c.default_partition),
    default_filename: s(c.default_filename),
    archive_folder: s(c.archive_folder),
    timezone: s(c.timezone),
    history: s(c.history),
    autolink: s(c.autolink),
  };
}

/** The fields whose value differs from the loaded one, as configure_database takes them. */
function changes(from: Form, to: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TEXT) if (to[k] !== from[k]) out[k] = to[k];
  for (const k of FLAGS) if (to[k] !== from[k] && to[k] !== "") out[k] = to[k] === "true";
  return out;
}

export function ConfigScreen(_props: { route: Route }): JSX.Element {
  const { api, catalog, toast, isOwner, readOnly } = useApp();
  const { data, error, reload } = useLoad<Described>(() => api.op<Described>("describe_database"), [api]);
  const [form, setForm] = useState<Form | null>(null);
  const [original, setOriginal] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<ErrorBody | null>(null);
  const [asking, setAsking] = useState<string[] | null>(null);

  useEffect(() => {
    if (!data) return;
    const f = formOf(data);
    setOriginal(f);
    setForm(f);
  }, [data]);

  if (error) return <ErrorBox body={error} />;
  if (!form || !original) return <Spinner />;

  const changed = changes(original, form);
  const names = Object.keys(changed);

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const a = await api.op("configure_database", changed);
      if (!a.ok) {
        setSaveError(errorBodyOf(a.json));
        return;
      }
      const id = (a.json as { migration_id?: unknown }).migration_id;
      toast({ text: "Configuration saved", ...(typeof id === "string" && undoable("configure_database") ? { undo: id } : {}) });
      reload();
      await catalog.refresh().catch(() => {});
    } catch (e) {
      setSaveError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const risky = names.filter((n) => n === "root" || n === "history");
    if (risky.length > 0) setAsking(risky);
    else void save();
  };

  const set = (k: keyof Form, v: string) => setForm({ ...form, [k]: v });

  return (
    <div class="admin-screen">
      <h1>Configuration</h1>
      {isOwner ? (
        <p class="ui-muted">
          The engine's own settings (port, logs, telemetry, semantic search, store backup) are in <a href={href("settings")}>Engine settings</a>.
        </p>
      ) : null}
      <form class="admin-form" onSubmit={(e) => e.preventDefault()}>
        {TEXT.map((k) => (
          <div class="ui-field" key={k}>
            <label for={`cfg-${k}`}>
              <code>{k}</code>
            </label>
            <input id={`cfg-${k}`} type="text" autocomplete="off" spellcheck={false} value={form[k]} onInput={(e) => set(k, e.currentTarget.value)} />
            <span class="ui-field-help">{HELP[k]}</span>
          </div>
        ))}
        {FLAGS.map((k) => (
          <div class="ui-field" key={k}>
            <label for={`cfg-${k}`}>
              <code>{k}</code>
            </label>
            <select id={`cfg-${k}`} value={form[k]} onChange={(e) => set(k, e.currentTarget.value)}>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
            <span class="ui-field-help">{HELP[k]}</span>
          </div>
        ))}
        <ErrorBox body={saveError} />
        <div class="admin-actions">
          <Button type="submit" kind="primary" disabled={busy || readOnly || names.length === 0} onClick={submit}>
            Save
          </Button>
          <Button disabled={busy || names.length === 0} onClick={() => setForm(original)}>
            Reset
          </Button>
          {readOnly ? <span class="ui-muted">Read only while viewing as a token.</span> : null}
        </div>
      </form>
      {asking ? (
        <ConfirmDialog
          title="Change the configuration?"
          confirmLabel="Save"
          danger
          message={
            <>
              {asking.includes("root") ? <p>Renaming root moves the database folder; links follow.</p> : null}
              {asking.includes("history") ? <p>history decides whether every table keeps a transaction log.</p> : null}
            </>
          }
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null);
            void save();
          }}
        />
      ) : null}
    </div>
  );
}
