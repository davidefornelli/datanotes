import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, DataTable, EmptyState, ErrorBox, errorBodyOf, Modal, OperationForm, Pager, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { actorLabel, pairChanges, type ActorLike, type RowDiff } from "../../lib/history";
import { href, navigate, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { VersionDiff } from "./VersionDiff";

export interface Commit {
  table?: string;
  tables?: string[];
  batch?: string;
  version: number;
  timestamp: string;
  operation: string;
  operation_parameters?: Record<string, unknown>;
  operation_metrics?: Record<string, unknown>;
  migration_id?: string;
  user_name?: string;
  actor?: ActorLike;
}

const BROWSE_LIMIT = 100;

function json(v: Record<string, unknown> | undefined): string {
  if (!v) return "";
  return Object.entries(v)
    .map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`)
    .join(", ");
}

function versionOf(q: string | undefined): number | null {
  return q !== undefined && /^\d+$/.test(q) ? Number(q) : null;
}

/** The rows of a table at one version, read only. */
function Browse(props: { table: string; version: number }): JSX.Element {
  const { api } = useApp();
  const [offset, setOffset] = useState(0);
  const [answer, setAnswer] = useState<{ total: number; rows: Record<string, unknown>[] } | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  useEffect(() => {
    let live = true;
    setAnswer(null);
    setError(null);
    api
      .op<{ total: number; rows: Record<string, unknown>[] }>("select_rows", { table: props.table, version: props.version, limit: BROWSE_LIMIT, offset })
      .then((a) => {
        if (!live) return;
        if (a.ok) setAnswer(a.json);
        else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, props.table, props.version, offset]);
  if (error) return <ErrorBox body={error} />;
  if (!answer) return <Spinner />;
  if (answer.rows.length === 0) return <EmptyState title={`The table had no rows at version ${props.version}.`} />;
  const keys: string[] = [];
  for (const r of answer.rows) for (const k of Object.keys(r)) if (k !== "path" && !keys.includes(k)) keys.push(k);
  return (
    <>
      <p class="ui-muted">
        {answer.total} row{answer.total === 1 ? "" : "s"} at version {props.version} (read only).
      </p>
      <DataTable columns={keys.map((k) => ({ key: k, label: k }))} rows={answer.rows} rowKey={(r) => String(r.path ?? JSON.stringify(r))} />
      <Pager total={answer.total} offset={offset} limit={BROWSE_LIMIT} sizes={[BROWSE_LIMIT]} onChange={(o) => setOffset(o)} />
    </>
  );
}

/** The changes between the picked versions (one picked: the changes of that version). */
function Diff(props: { table: string; from: number; to: number }): JSX.Element {
  const { api } = useApp();
  const [diffs, setDiffs] = useState<RowDiff[] | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const start = props.from === props.to ? props.from : props.from + 1;
  useEffect(() => {
    let live = true;
    setDiffs(null);
    setError(null);
    api
      .op<{ changes: Record<string, unknown>[] }>("table_changes", { table: props.table, start_version: start, end_version: props.to })
      .then((a) => {
        if (!live) return;
        if (a.ok) setDiffs(pairChanges(a.json.changes));
        else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, props.table, start, props.to]);
  if (error) return <ErrorBox body={error} />;
  if (!diffs) return <Spinner />;
  return <VersionDiff diffs={diffs} table={props.table} />;
}

/** A table's versions: pick two to compare, browse one, restore to one. */
export function TableHistoryScreen(props: { route: Route }): JSX.Element {
  const { api, readOnly } = useApp();
  const table = props.route.params.table ?? "";
  const from = versionOf(props.route.query.from);
  const to = versionOf(props.route.query.to);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [browse, setBrowse] = useState<number | null>(null);
  const [restore, setRestore] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setCommits(null);
    setError(null);
    api
      .op<{ history: Commit[] }>("describe_history", { table, limit: 50 })
      .then((a) => {
        if (!live) return;
        if (a.ok) setCommits(a.json.history);
        else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, table, reload]);

  const picked = [from, to].filter((v): v is number => v !== null);
  const pick = (v: number) => {
    let next: number[];
    if (picked.includes(v)) next = picked.filter((p) => p !== v);
    else next = [...picked, v].slice(-2);
    next.sort((a, b) => a - b);
    const query: Record<string, string> = {};
    if (next[0] !== undefined) query.from = String(next[0]);
    if (next[1] !== undefined) query.to = String(next[1]);
    navigate("table-history", { table }, query, true);
  };

  if (error) {
    return (
      <div class="history-screen">
        <h1>History of {table}</h1>
        <ErrorBox body={error} />
        <p>
          <a href={href("table", { table }, { tab: "overview" })}>Open the table's structure</a> to turn its history on.
        </p>
      </div>
    );
  }
  if (!commits) return <Spinner />;
  const lo = picked[0];
  const hi = picked[1] ?? lo;

  return (
    <div class="history-screen">
      <h1>History of {table}</h1>
      <p>
        <a href={href("rows", { object: table })}>Rows</a> · <a href={href("journal", {}, { table })}>Journal</a> ·{" "}
        <a href={href("database-history")}>Database history</a>
      </p>
      {commits.length === 0 ? (
        <EmptyState title="This table has no versions yet." />
      ) : (
        <>
          <p class="ui-muted">Pick one version to see its changes, or two to compare them.</p>
          <div class="ui-table-wrap">
            <table class="ui-table history-table">
              <thead>
                <tr>
                  <th>Pick</th>
                  <th>Version</th>
                  <th>Time</th>
                  <th>Operation</th>
                  <th>Parameters</th>
                  <th>Who</th>
                  <th>Metrics</th>
                  <th>Migration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {commits.map((c) => (
                  <tr key={c.version} class={picked.includes(c.version) ? "history-picked" : undefined}>
                    <td>
                      <input type="checkbox" aria-label={`Pick version ${c.version}`} checked={picked.includes(c.version)} onChange={() => pick(c.version)} />
                    </td>
                    <td class="history-num">{c.version}</td>
                    <td class="history-nowrap" title={c.timestamp}>
                      {formatTime(c.timestamp)}
                    </td>
                    <td>{c.operation}</td>
                    <td class="history-small">{json(c.operation_parameters)}</td>
                    <td>{c.actor || c.user_name ? actorLabel(c.actor, c.user_name) : <span class="ui-muted">engine or hand edit</span>}</td>
                    <td class="history-small">{json(c.operation_metrics)}</td>
                    <td>
                      {c.migration_id ? (
                        <a href={href("journal", {}, { table })} title="Open the journal">
                          <code>{c.migration_id}</code>
                        </a>
                      ) : null}
                    </td>
                    <td class="history-actions">
                      <Button onClick={() => setBrowse(browse === c.version ? null : c.version)}>{browse === c.version ? "Close" : "Browse at this version"}</Button>
                      {!readOnly ? (
                        <Button kind="plain" onClick={() => setRestore(c.version)}>
                          Restore to this version…
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {browse !== null ? (
        <section>
          <h2>Rows at version {browse}</h2>
          <Browse table={table} version={browse} />
        </section>
      ) : null}
      {lo !== undefined && hi !== undefined ? (
        <section>
          <h2>{lo === hi ? `Changes of version ${lo}` : `Changes from version ${lo} to ${hi}`}</h2>
          <Diff table={table} from={lo} to={hi} />
        </section>
      ) : null}
      {restore !== null ? (
        <Modal title={`Restore ${table} to version ${restore}`} onClose={() => setRestore(null)} wide>
          <p>The restore is a new version: history is kept, and you can undo it.</p>
          <OperationForm
            op="restore_table"
            fixed={{ table, version: restore }}
            hide={["timestamp"]}
            confirm={`Restore ${table} to version ${restore}? Rows added since are deleted and changed rows get their old content.`}
            onDone={(a) => a.ok && setReload((n) => n + 1)}
          />
        </Modal>
      ) : null}
    </div>
  );
}
