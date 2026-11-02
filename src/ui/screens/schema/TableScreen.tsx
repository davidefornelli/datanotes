// A table's full definition in tabs (overview, columns, constraints, relations, actions), with the
// descriptions of its catalog and schema. A schema change made elsewhere shows a banner to reload.

import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button, ErrorBox, Spinner, Tabs } from "../../components";
import type { ApiAnswer } from "../../lib/api";
import { href, navigate, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { ActionsTab } from "./ActionsTab";
import { ColumnsTab } from "./ColumnsTab";
import { ConstraintsTab } from "./ConstraintsTab";
import { OverviewTab } from "./OverviewTab";
import { RelationsTab } from "./RelationsTab";
import { DdlRunner, TextArea, useDescribed } from "./shared";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "columns", label: "Columns" },
  { id: "constraints", label: "Constraints" },
  { id: "relations", label: "Relations" },
  { id: "actions", label: "Actions" },
];

/** The description of a catalog (schema omitted) or of a schema, with Edit (comment_on). */
function Comment(props: { label: string; catalog: string; schema?: string; description?: string }): JSX.Element {
  const { readOnly } = useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(props.description ?? "");
  const args: Record<string, unknown> = { catalog: props.catalog, description: text };
  if (props.schema) args.schema = props.schema;
  return (
    <div class="schema-comment">
      <span class="schema-prop-label">{props.label}</span> {props.description ?? <span class="ui-muted">no description</span>}{" "}
      {readOnly ? null : <Button onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</Button>}
      {open ? (
        <div class="schema-prop-form">
          <TextArea label='What it holds ("" removes it)' value={text} onInput={setText} />
          <DdlRunner op="comment_on" args={args} onApplied={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

function Comments(props: { catalog: string; schema: string }): JSX.Element | null {
  const { catalog } = useApp();
  const [found, setFound] = useState<{ catalog?: string; schema?: string } | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      catalog
        .load()
        .then((t) => {
          if (!live) return;
          const c = t.catalogs.find((x) => x.catalog === props.catalog);
          const s = c?.schemas.find((x) => x.schema === props.schema);
          const out: { catalog?: string; schema?: string } = {};
          if (c?.description) out.catalog = c.description;
          if (s?.description) out.schema = s.description;
          setFound(out);
        })
        .catch(() => undefined);
    void load();
    const off = catalog.subscribe(() => void load());
    return () => {
      live = false;
      off();
    };
  }, [catalog, props.catalog, props.schema]);
  if (!found) return null;
  return (
    <div class="schema-comments">
      <Comment key={`c:${found.catalog ?? ""}`} label={`Catalog ${props.catalog}:`} catalog={props.catalog} description={found.catalog} />
      <Comment key={`s:${found.schema ?? ""}`} label={`Schema ${props.schema}:`} catalog={props.catalog} schema={props.schema} description={found.schema} />
    </div>
  );
}

export function TableScreen(props: { route: Route }): JSX.Element {
  const table = props.route.params.table ?? "";
  const tab = TABS.some((t) => t.id === props.route.query.tab) ? (props.route.query.tab as string) : "overview";
  const { bus, catalog } = useApp();
  const { data, error, reload } = useDescribed(table);
  const [changed, setChanged] = useState(false);
  const [round, setRound] = useState(0);
  const own = useRef(new Set<string>());

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const off = bus.subscribe(
      (events, info) => {
        if (info.gap) setChanged(true);
        for (const e of events) {
          if (e.kind !== "metastore") continue;
          // this screen's own change may arrive before its answer is handled: wait a moment
          timers.push(setTimeout(() => !(e.migration_id && own.current.has(e.migration_id)) && setChanged(true), 2000));
        }
      },
      { kinds: ["metastore"] },
    );
    return () => {
      off();
      timers.forEach(clearTimeout);
    };
  }, [bus]);
  // the tabs' forms start again from each new definition
  useEffect(() => setRound((n) => n + 1), [data]);

  const applied = (a: ApiAnswer) => {
    const id = (a.json as { migration_id?: unknown }).migration_id;
    if (typeof id === "string") own.current.add(id);
    reload();
  };
  const reloadAll = () => {
    setChanged(false);
    void catalog
      .refresh()
      .catch(() => undefined)
      .then(reload);
  };

  if (error) return <ErrorBox body={error} title={`Table ${table}`} />;
  if (!data) return <Spinner />;
  return (
    <div class="schema-table">
      <header class="schema-head">
        <h1>{data.qualified}</h1>
        <nav class="schema-links">
          <a href={href("rows", { object: data.qualified })}>Rows</a>
          <a href={href("table-history", { table: data.qualified })}>History</a>
        </nav>
      </header>
      {changed ? (
        <div class="schema-banner" role="status">
          The structure changed. <Button onClick={reloadAll}>Reload</Button>
        </div>
      ) : null}
      <Comments catalog={data.catalog} schema={data.schema} />
      <Tabs tabs={TABS} active={tab} onChange={(id) => navigate("table", { table }, { tab: id }, true)} />
      <div class="schema-tab" key={`${tab}:${round}`}>
        {tab === "overview" ? <OverviewTab data={data} onApplied={applied} /> : null}
        {tab === "columns" ? <ColumnsTab data={data} onApplied={applied} /> : null}
        {tab === "constraints" ? <ConstraintsTab data={data} onApplied={applied} /> : null}
        {tab === "relations" ? <RelationsTab data={data} /> : null}
        {tab === "actions" ? <ActionsTab data={data} onApplied={applied} /> : null}
      </div>
    </div>
  );
}
