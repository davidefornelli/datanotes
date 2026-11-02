import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, EmptyState, ErrorBox, errorBodyOf, Modal, OperationForm, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { actorLabel } from "../../lib/history";
import { href, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { useMaintain } from "./Journal";
import type { Commit } from "./TableHistory";

/** The commits of every table with a log, newest first; restore the whole database to a time. */
export function DatabaseHistoryScreen(_props: { route: Route }): JSX.Element {
  const { api } = useApp();
  const canRestore = useMaintain();
  const [answer, setAnswer] = useState<{ tables: string[]; history: Commit[] } | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setAnswer(null);
    setError(null);
    api
      .op<{ tables: string[]; history: Commit[] }>("describe_history", { limit: 100 })
      .then((a) => {
        if (!live) return;
        if (a.ok) setAnswer(a.json);
        else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, reload]);

  if (error) return <ErrorBox body={error} />;
  if (!answer) return <Spinner />;

  return (
    <div class="history-screen">
      <h1>Database history</h1>
      {canRestore ? (
        <p>
          <Button kind="plain" onClick={() => setRestoring(true)}>
            Restore the database to a time…
          </Button>
        </p>
      ) : null}
      {answer.tables.length ? (
        <p class="history-table-links">
          Tables with history:{" "}
          {answer.tables.map((t, i) => (
            <span key={t}>
              {i > 0 ? ", " : ""}
              <a href={href("table-history", { table: t })}>{t}</a>
            </span>
          ))}
        </p>
      ) : null}
      {answer.history.length === 0 ? (
        <EmptyState title="No table keeps a history yet." />
      ) : (
        <div class="ui-table-wrap">
          <table class="ui-table history-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Table</th>
                <th>Version</th>
                <th>Operation</th>
                <th>Who</th>
                <th>Migration</th>
                <th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {answer.history.map((c, i) => (
                <tr key={`${c.table ?? ""}:${c.version}:${i}`}>
                  <td class="history-nowrap" title={c.timestamp}>
                    {formatTime(c.timestamp)}
                  </td>
                  <td>
                    {c.table ? <a href={href("table-history", { table: c.table })}>{c.table}</a> : null}
                    {c.tables && c.tables.length > 1 ? <div class="ui-muted history-small">with {c.tables.filter((t) => t !== c.table).join(", ")}</div> : null}
                  </td>
                  <td class="history-num">
                    {c.table ? <a href={href("table-history", { table: c.table }, { from: String(c.version) })}>{c.version}</a> : c.version}
                  </td>
                  <td>{c.operation}</td>
                  <td>{c.actor || c.user_name ? actorLabel(c.actor, c.user_name) : <span class="ui-muted">engine or hand edit</span>}</td>
                  <td>{c.migration_id ? <code>{c.migration_id}</code> : null}</td>
                  <td>{c.batch ? <code>{c.batch}</code> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {restoring ? (
        <Modal title="Restore the database to a time" onClose={() => setRestoring(false)} wide>
          <p>Each table with a log goes back to its last version at or before the time. The restore is one operation: you can undo it.</p>
          <OperationForm
            op="restore_database"
            hide={["before_migration"]}
            confirm="Restore every table to that time? Rows written since then change or go away."
            onDone={(a) => a.ok && setReload((n) => n + 1)}
          />
        </Modal>
      ) : null}
    </div>
  );
}
