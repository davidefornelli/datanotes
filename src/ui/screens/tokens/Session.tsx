import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, DataTable, EmptyState, ErrorBox, errorBodyOf, Spinner, Tabs } from "../../components";
import type { ErrorBody } from "../../lib/api";
import type { WireEvent } from "../../lib/changes";
import { formatTime } from "../../lib/format";
import { href, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { ago, DAY_MS, sameSession, Show, useAnswer, type SessionEntry } from "./common";

const PAGE = 500;

/** #/users/<name>/sessions/<session>: one agent session's tool calls and row changes ("-": the work without a session). */
export function SessionScreen(props: { route: Route }): JSX.Element {
  const { api } = useApp();
  const name = props.route.params.name ?? "";
  const session = props.route.params.session ?? "-";
  const [tab, setTab] = useState("calls");
  const loaded = useAnswer(() => api.route<{ sessions: SessionEntry[] }>("/sessions/", { token: name, since: ago(30 * DAY_MS), limit: 1000 }), [api, name]);

  return (
    <div class="tokens-screen">
      <p>
        <a href={href("users")}>Users</a> / <a href={href("user", { name })}>{name}</a> / <code>{session === "-" ? "(no session)" : session}</code>
      </p>
      <Show loaded={loaded}>
        {(data) => {
          const s = data.sessions.find((x) => sameSession(x, session));
          if (!s) return <EmptyState title="No such session in the last 30 days" />;
          return (
            <>
              <h1>{session === "-" ? "Work without a session" : `Session ${s.session ?? ""}`}</h1>
              <dl class="tokens-facts">
                <div>
                  <dt>Harness</dt>
                  <dd>{s.harness ?? "—"}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{s.model ?? "—"}</dd>
                </div>
                <div>
                  <dt>From</dt>
                  <dd>
                    {formatTime(s.first_at)} to {formatTime(s.last_at)}
                  </dd>
                </div>
                <div>
                  <dt>Tool calls</dt>
                  <dd>
                    {s.tool_call_count} ({s.failed_tool_call_count} failed)
                  </dd>
                </div>
                <div>
                  <dt>Row changes</dt>
                  <dd>
                    {s.row_change_count} in {s.migration_count} operations
                  </dd>
                </div>
                <div>
                  <dt>Tables</dt>
                  <dd>{s.tables.join(", ") || "—"}</dd>
                </div>
              </dl>
              <Tabs
                tabs={[
                  { id: "calls", label: "Tool calls" },
                  { id: "changes", label: "Row changes" },
                ]}
                active={tab}
                onChange={setTab}
              />
              <Events key={tab} name={name} session={session} since={s.first_seq - 1} calls={tab === "calls"} />
            </>
          );
        }}
      </Show>
    </div>
  );
}

/** The change feed's events of this credential and session, paged from the session's first event. */
function Events(props: { name: string; session: string; since: number; calls: boolean }): JSX.Element {
  const { api } = useApp();
  const [events, setEvents] = useState<WireEvent[] | null>(null);
  const [cursor, setCursor] = useState(props.since);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const load = async (since: number, append: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const a = await api.op<{ events: WireEvent[]; last: number; head: number }>("list_changes", {
        auth: props.name,
        ...(props.session === "-" ? {} : { session: props.session }),
        ...(props.calls ? { kinds: ["tool_call"] } : {}),
        since,
        limit: PAGE,
      });
      if (!a.ok) {
        setError(errorBodyOf(a.json));
        return;
      }
      // without a session filter, keep the events whose actor has no session
      const got = props.session === "-" ? a.json.events.filter((e) => !e.actor?.session) : a.json.events;
      setEvents((old) => (append && old ? [...old, ...got] : got));
      setCursor(a.json.last);
      setMore(a.json.last < a.json.head);
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load(props.since, false);
  }, [api, props.name, props.session, props.since, props.calls]);

  if (error && !events) return <ErrorBox body={error} />;
  if (!events) return <Spinner />;
  const flip = (seq: number) => {
    const next = new Set(open);
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    setOpen(next);
  };
  return (
    <div>
      <ErrorBox body={error} />
      {events.length === 0 ? (
        <EmptyState title={props.calls ? "No tool calls" : "No row changes"} />
      ) : props.calls ? (
        <div class="ui-table-wrap">
          <table class="ui-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Tool</th>
                <th>ok</th>
                <th>duration_ms</th>
                <th>served_by</th>
                <th>result_tokens</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const c = e.call ?? {};
                return [
                  <tr key={e.seq} class="ui-table-clickable" onClick={() => flip(e.seq)} aria-expanded={open.has(e.seq)}>
                    <td>{formatTime(e.at)}</td>
                    <td>
                      <code>{String(c.tool ?? "")}</code>
                    </td>
                    <td>{c.ok === false ? <span class="tokens-failed">failed</span> : "ok"}</td>
                    <td>{c.duration_ms === undefined ? "" : String(c.duration_ms)}</td>
                    <td>{c.served_by === undefined ? "" : String(c.served_by)}</td>
                    <td>{c.result_tokens === undefined ? "" : String(c.result_tokens)}</td>
                  </tr>,
                  open.has(e.seq) ? (
                    <tr key={`${e.seq}:detail`}>
                      <td colSpan={6}>
                        <p class="ui-muted">args</p>
                        <pre class="tokens-pre">{JSON.stringify(c.args ?? null, null, 2)}</pre>
                        <p class="ui-muted">value</p>
                        <pre class="tokens-pre">{JSON.stringify(c.value ?? null, null, 2)}</pre>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <DataTable
          rows={events as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.seq)}
          columns={[
            { key: "at", label: "Time", render: (r) => formatTime(String(r.at)) },
            { key: "kind", label: "Kind" },
            { key: "table", label: "Table" },
            { key: "path", label: "Path", render: (r) => <a href={href("open", {}, { path: String(r.path) })}>{String(r.path)}</a> },
            { key: "migration_id", label: "Migration", render: (r) => (typeof r.migration_id === "string" ? <a href={href("journal")}>{r.migration_id}</a> : "") },
          ]}
        />
      )}
      {more ? (
        <Button disabled={busy} onClick={() => void load(cursor, true)}>
          More
        </Button>
      ) : null}
    </div>
  );
}
