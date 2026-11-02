import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Button, EmptyState, ErrorBox, errorBodyOf, Spinner, WriteResult } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { undoable } from "../../lib/format";
import { insertValues, rawOf, readOnlyColumn, type Raw } from "../../lib/row-form";
import { href, navigate, type Route } from "../../lib/router";
import { isWriteAnswer, type WriteAnswer } from "../../lib/write-result";
import { useApp } from "../../state";
import { bodyOf, described, type Described } from "./common";
import { FieldInput } from "./FieldInput";
import { BodyEditor, fieldErrors, RefusalView, refusalOf, type Refusal } from "./FormParts";

/** #/new-row/<table>: the row form, empty; defaults shown, applied by the engine. */
export function NewRowScreen(props: { route: Route }): JSX.Element {
  const { api, catalog, readOnly, toast } = useApp();
  const table = props.route.params.table ?? "";
  const [desc, setDesc] = useState<Described | null>(null);
  const [loadError, setLoadError] = useState<ErrorBody | null>(null);
  const [raws, setRaws] = useState<Record<string, Raw>>({});
  const [body, setBody] = useState("");
  const [path, setPath] = useState("");
  // D12: a person typing expects the text saved as typed; ticking the box links the notes it mentions
  const [autolink, setAutolink] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<{ r: Refusal; status: number } | null>(null);
  const [checked, setChecked] = useState<{ answer: WriteAnswer; status: number } | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setDesc(null);
    setLoadError(null);
    catalog
      .describe(table)
      .then((a) => {
        if (!live) return;
        if (!a.ok) setLoadError(bodyOf(a));
        else {
          const d = described(a);
          setDesc(d);
          setRaws(Object.fromEntries(d.columns.map((c) => [c.name, rawOf(c, undefined)])));
        }
      })
      .catch((e: unknown) => live && setLoadError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [catalog, table]);

  const values = useMemo(() => (desc ? insertValues(desc.columns, raws).values : {}), [desc, raws]);

  if (readOnly) return <EmptyState title="Read only: you are viewing as a token." />;
  if (loadError) return <ErrorBox body={loadError} />;
  if (!desc) return <Spinner />;

  const insert = async (dryRun: boolean) => {
    const v = insertValues(desc.columns, raws);
    setFormErrors(v.errors);
    if (Object.keys(v.errors).length) return;
    const args: Record<string, unknown> = { table, values: v.values, autolink, dry_run: dryRun };
    if (body.trim()) args.body = body;
    if (path.trim()) args.path = path.trim();
    setBusy(true);
    setError(null);
    setChecked(null);
    try {
      const a = await api.op("insert_row", args);
      if (!isWriteAnswer(a.json)) {
        setRefusal(null);
        setError(bodyOf(a));
        return;
      }
      const w = a.json;
      if (!w.ok) {
        setRefusal({ r: refusalOf(w), status: a.status });
        return;
      }
      setRefusal(null);
      if (dryRun) {
        setChecked({ answer: w, status: a.status });
        return;
      }
      toast({ text: "Inserted", kind: "ok", ...(w.migration_id && undoable("insert_row") ? { undo: w.migration_id } : {}) });
      const created = w.planned_creates[0];
      if (created) navigate("row", { table }, { path: created });
      else navigate("rows", { object: table });
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="rows-screen rows-editor">
      <div class="rows-head">
        <div>
          <p class="ui-muted rows-crumb">
            <a href={href("rows", { object: table })}>{table}</a>
          </p>
          <h1 class="rows-title">New row</h1>
          {desc.description ? <p class="ui-muted rows-description">{desc.description}</p> : null}
        </div>
      </div>
      {refusal ? <RefusalView refusal={refusal.r} hints={desc.constraintHints} status={refusal.status} /> : null}
      <ErrorBox body={error} />
      {checked ? <WriteResult answer={checked.answer} status={checked.status} /> : null}

      <form class="rows-form" onSubmit={(e) => e.preventDefault()}>
        {desc.columns.map((c) => (
          <FieldInput
            key={c.name}
            column={c}
            raw={raws[c.name] ?? rawOf(c, undefined)}
            onChange={(r) => setRaws({ ...raws, [c.name]: r })}
            errors={fieldErrors(c.name, formErrors, refusal?.r ?? null)}
            disabled={readOnlyColumn(c)}
            table={table}
            rowValues={values}
            showDefault
          />
        ))}
      </form>

      <h2>Body</h2>
      <BodyEditor value={body} onChange={setBody} />

      <details class="rows-advanced">
        <summary>Advanced</summary>
        <label class="ui-field">
          <span>Path (leave empty: the table's filename pattern names the note)</span>
          <input type="text" autocomplete="off" value={path} onInput={(e) => setPath(e.currentTarget.value)} />
        </label>
      </details>

      <div class="rows-form-buttons">
        <label class="rows-autolink">
          <input type="checkbox" checked={autolink} onChange={(e) => setAutolink(e.currentTarget.checked)} /> Link the notes this text mentions
        </label>
        <Button disabled={busy} onClick={() => void insert(true)}>
          Check
        </Button>
        <Button kind="primary" disabled={busy} onClick={() => void insert(false)}>
          Insert
        </Button>
      </div>
    </div>
  );
}
