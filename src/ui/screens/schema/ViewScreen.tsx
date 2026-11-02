// A view: its definition (description, aliases, labels, query), a preview of its rows, an editor
// that replaces it (create_view replace: true) and Drop.

import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, DataTable, EmptyState, ErrorBox, errorBodyOf, JsonEditor, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import type { ViewInfo } from "../../lib/catalog";
import { displayValue } from "../../lib/format";
import { href, navigate, type Route } from "../../lib/router";
import { previewArgs, splitQualified } from "../../lib/view-query";
import { useApp } from "../../state";
import { DdlRunner, linesOf, Section, TextArea } from "./shared";

/** The rows of a select_rows call, in a table; `args` null shows `none` instead. */
export function RowsPreview(props: { args: Record<string, unknown> | null; none?: string }): JSX.Element {
  const { api } = useApp();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<ErrorBody | null>(null);
  const key = JSON.stringify(props.args);
  useEffect(() => {
    if (!props.args) return;
    let live = true;
    setRows(null);
    setError(null);
    api
      .op<{ rows?: Record<string, unknown>[]; total?: number }>("select_rows", props.args)
      .then((a) => {
        if (!live) return;
        if (a.ok) {
          setRows(a.json.rows ?? []);
          setTotal(a.json.total ?? 0);
        } else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, key]);
  if (!props.args) return <p class="ui-muted">{props.none ?? "Nothing to preview."}</p>;
  if (error) return <ErrorBox body={error} />;
  if (!rows) return <Spinner />;
  if (rows.length === 0) return <EmptyState title="No rows." />;
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (k !== "path" && !keys.includes(k)) keys.push(k);
  return (
    <div class="schema-preview">
      <p class="ui-muted">
        {rows.length} of {total} rows.
      </p>
      <DataTable
        columns={keys.map((k) => ({ key: k, label: k, render: (r: Record<string, unknown>) => displayValue(r[k]) }))}
        rows={rows}
        rowKey={(r) => String(r.path ?? JSON.stringify(r))}
      />
    </div>
  );
}

function ViewEditor(props: { info: ViewInfo; onApplied(): void }): JSX.Element {
  const p = splitQualified(props.info.qualified);
  const [query, setQuery] = useState<unknown>(props.info.query ?? {});
  const [queryError, setQueryError] = useState<string | null>(null);
  const [description, setDescription] = useState(props.info.description ?? "");
  const [aliases, setAliases] = useState(props.info.aliases.join("\n"));
  const [labels, setLabels] = useState<unknown>(props.info.labels);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null | undefined>(undefined);
  const isQuery = query !== null && typeof query === "object" && !Array.isArray(query);
  const args: Record<string, unknown> = { name: p.name, catalog: p.catalog, schema: p.schema, query, replace: true };
  if (description.trim()) args.description = description.trim();
  args.aliases = linesOf(aliases);
  if (labels && typeof labels === "object") args.labels = labels;
  return (
    <>
      <JsonEditor
        label="Query (select_rows arguments, or a union)"
        rows={10}
        value={query}
        onChange={(v, err) => {
          setQuery(v);
          setQueryError(err);
        }}
      />
      <TextArea label="Description" value={description} onInput={setDescription} />
      <TextArea label="Aliases, one per line" value={aliases} onInput={setAliases} />
      <JsonEditor
        label="Labels: column → heading"
        rows={3}
        value={labels}
        onChange={(v, err) => {
          setLabels(v);
          setLabelsError(err);
        }}
      />
      <p>
        <Button disabled={!isQuery} onClick={() => setPreview(isQuery ? previewArgs(query as Record<string, unknown>) : null)}>
          Preview the edited query
        </Button>
      </p>
      {preview !== undefined ? <RowsPreview args={preview} none="A union query: use Check to run it." /> : null}
      <DdlRunner
        op="create_view"
        args={isQuery ? args : null}
        problems={[queryError, labelsError].filter((x): x is string => Boolean(x))}
        onApplied={props.onApplied}
      />
    </>
  );
}

export function ViewScreen(props: { route: Route }): JSX.Element {
  const view = props.route.params.view ?? "";
  const { catalog, readOnly } = useApp();
  const [info, setInfo] = useState<ViewInfo | null | undefined>(undefined);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    const load = () =>
      catalog
        .views()
        .then((list) => {
          if (!live) return;
          setInfo(list.find((v) => v.qualified === view) ?? list.find((v) => splitQualified(v.qualified).name === view) ?? null);
          setRound((n) => n + 1);
        })
        .catch((e: unknown) => live && setError(errorBodyOf(e)));
    void load();
    const off = catalog.subscribe(() => void load());
    return () => {
      live = false;
      off();
    };
  }, [catalog, view]);

  if (error) return <ErrorBox body={error} />;
  if (info === undefined) return <Spinner />;
  if (info === null) return <EmptyState title={`No view named ${view}.`} />;
  return (
    <div class="schema-view">
      <header class="schema-head">
        <h1>{info.qualified}</h1>
        <nav class="schema-links">
          <a href={href("rows", { object: info.qualified })}>Rows</a>
        </nav>
      </header>
      <div class="schema-prop">
        <span class="schema-prop-label">Description</span> {info.description ?? <span class="ui-muted">none</span>}
      </div>
      <div class="schema-prop">
        <span class="schema-prop-label">Aliases</span> {info.aliases.length ? info.aliases.join(", ") : <span class="ui-muted">none</span>}
      </div>
      <div class="schema-prop">
        <span class="schema-prop-label">Labels</span>{" "}
        {Object.keys(info.labels).length ? (
          Object.entries(info.labels)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        ) : (
          <span class="ui-muted">none</span>
        )}
      </div>
      <div class="schema-prop">
        <span class="schema-prop-label">Query</span>
        <pre class="schema-pre">{JSON.stringify(info.query, null, 2)}</pre>
      </div>
      <Section title="Preview (20 rows)" open>
        <RowsPreview args={{ table: info.qualified, limit: 20 }} />
      </Section>
      {readOnly ? null : (
        <>
          <Section title="Edit">
            <ViewEditor key={round} info={info} onApplied={() => undefined} />
          </Section>
          <Section title="Drop">
            <DdlRunner
              op="drop_view"
              args={{ view: info.qualified }}
              confirmMessage={<p>Drop the view {info.qualified}? Undo brings it back.</p>}
              applyLabel="Drop"
              onApplied={() => navigate("home", {}, {}, true)}
            />
          </Section>
        </>
      )}
    </div>
  );
}
