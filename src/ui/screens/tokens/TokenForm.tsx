import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Button, ErrorBox, errorBodyOf, Modal } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { draftFrom, draftProblems, draftToCreate, draftToUpdate, matchesPattern, patternSuggestions, type TokenDraft } from "../../lib/patterns";
import { useApp } from "../../state";
import { tableNames, type TokenEntry } from "./common";

/** One pattern per line; blank lines left out. */
function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export interface TokenFormProps {
  /** null: a new token. */
  entry: TokenEntry | null;
  /** In a dialog (the token list) or inline (the token page). */
  modal: boolean;
  /** After the engine saved it: the answer of /tokens/create/ ({entry, token}) or /tokens/update/ ({entry}). */
  onSaved(json: Record<string, unknown>, created: boolean): void;
  onCancel?(): void;
}

/** Create or change a named token. The engine judges on save; the form only warns while typing. */
export function TokenForm(props: TokenFormProps): JSX.Element {
  const { api, catalog } = useApp();
  const creating = props.entry === null;
  const start = useMemo(() => draftFrom(props.entry as unknown as Record<string, unknown> | null), [props.entry]);
  const [draft, setDraft] = useState<TokenDraft>(start);
  const [readText, setReadText] = useState(start.read.join("\n"));
  const [writeText, setWriteText] = useState(start.write.join("\n"));
  const [tables, setTables] = useState<string[]>([]);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    catalog
      .load()
      .then((tree) => live && setTables(tableNames(tree)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [catalog]);

  const d: TokenDraft = { ...draft, read: linesOf(readText), write: linesOf(writeText) };
  const problems = draftProblems(d, creating);
  const patch = creating ? null : draftToUpdate(props.entry as unknown as Record<string, unknown>, d);
  const unchanged = patch !== null && Object.keys(patch).length === 0;
  const suggestions = patternSuggestions(tables);
  const reads = d.readAll ? tables.length : tables.filter((t) => matchesPattern(t, d.read)).length;
  const writes = tables.filter((t) => matchesPattern(t, d.write)).length;
  const set = (p: Partial<TokenDraft>) => setDraft({ ...draft, ...p });
  const addLine = (text: string, p: string, put: (t: string) => void) => {
    if (linesOf(text).includes(p)) return;
    put(text.trim() ? `${text.replace(/\s+$/, "")}\n${p}` : p);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = creating ? await api.route("/tokens/create/", draftToCreate(d)) : await api.route("/tokens/update/", { name: props.entry!.name, ...patch });
      if (a.ok) props.onSaved(a.json, creating);
      else setError(errorBodyOf(a.json));
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  const fields = (
    <div class="tokens-form">
      {creating ? (
        <label class="ui-field">
          <span>Name</span>
          <input type="text" autocomplete="off" spellcheck={false} value={draft.name} onInput={(e) => set({ name: e.currentTarget.value })} />
          <span class="ui-field-help">Kebab-case: a-z, 0-9 and -. The journal records it with every write.</span>
        </label>
      ) : null}
      <label class="ui-field">
        <span>Description</span>
        <textarea rows={2} value={draft.description} onInput={(e) => set({ description: e.currentTarget.value })} />
      </label>
      <fieldset class="tokens-fieldset">
        <legend>Read</legend>
        <label class="tokens-radio">
          <input type="radio" name="tokens-read" checked={draft.readAll} onChange={() => set({ readAll: true })} /> Every table
        </label>
        <label class="tokens-radio">
          <input type="radio" name="tokens-read" checked={!draft.readAll} onChange={() => set({ readAll: false })} /> Only these
        </label>
        {draft.readAll ? null : (
          <>
            <textarea rows={4} spellcheck={false} aria-label="Read patterns, one per line" value={readText} onInput={(e) => setReadText(e.currentTarget.value)} />
            <Suggestions list={suggestions} onPick={(p) => addLine(readText, p, setReadText)} />
          </>
        )}
      </fieldset>
      <fieldset class="tokens-fieldset">
        <legend>Write</legend>
        <textarea rows={3} spellcheck={false} aria-label="Write patterns, one per line" value={writeText} onInput={(e) => setWriteText(e.currentTarget.value)} />
        <Suggestions list={suggestions} onPick={(p) => addLine(writeText, p, setWriteText)} />
        <span class="ui-field-help">One pattern per line: a table name, catalog.schema.*, catalog.* or *.</span>
      </fieldset>
      <label class="tokens-check">
        <input type="checkbox" checked={draft.ddl} onChange={(e) => set({ ddl: e.currentTarget.checked })} /> ddl: may change the schema
      </label>
      <label class="tokens-check">
        <input type="checkbox" checked={draft.maintain} onChange={(e) => set({ maintain: e.currentTarget.checked })} /> maintain
      </label>
      <p class="ui-field-help">maintain lets the token run maintenance; the engine's settings, tokens and status stay the owner's</p>
      <label class="ui-field">
        <span>Automatic links of its writes</span>
        <select value={draft.autolink} onChange={(e) => set({ autolink: e.currentTarget.value as TokenDraft["autolink"] })}>
          <option value="default">default (the database's setting)</option>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>
      </label>
      <p class="tokens-preview">
        Reads {reads} of {tables.length} tables, writes {writes}
      </p>
      {problems.length ? (
        <ul class="tokens-problems">
          {problems.map((p) => (
            <li key={p} class="ui-field-error">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorBox body={error} />
    </div>
  );
  const buttons = (
    <>
      {props.onCancel ? <Button onClick={props.onCancel}>Cancel</Button> : null}
      <Button kind="primary" disabled={busy || problems.length > 0 || unchanged} onClick={() => void save()}>
        {creating ? "Create" : "Save"}
      </Button>
    </>
  );
  if (props.modal) {
    return (
      <Modal title={creating ? "New token" : `Edit ${props.entry!.name}`} onClose={() => props.onCancel?.()} footer={buttons} wide>
        {fields}
      </Modal>
    );
  }
  return (
    <div>
      {fields}
      <div class="tokens-actions">{buttons}</div>
    </div>
  );
}

function Suggestions(props: { list: string[]; onPick(p: string): void }): JSX.Element {
  return (
    <div class="ui-chips tokens-suggestions" aria-label="Suggested patterns">
      {props.list.map((p) => (
        <button key={p} type="button" class="ui-chip" onClick={() => props.onPick(p)}>
          {p}
        </button>
      ))}
    </div>
  );
}
