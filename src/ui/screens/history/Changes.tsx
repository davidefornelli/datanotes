import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Badge, Button, EmptyState, ErrorBox, errorBodyOf, JsonEditor, Spinner, ValueView } from "../../components";
import { AuthRefused, type ErrorBody } from "../../lib/api";
import type { WireEvent } from "../../lib/changes";
import { formatTime, relativeTime } from "../../lib/format";
import { actorLabel, changeSummary } from "../../lib/history";
import { href, type Route } from "../../lib/router";
import { useApp } from "../../state";

const KINDS = ["insert", "update", "delete", "move", "metastore", "unreadable", "tool_call"] as const;
const PAGE = 200;
const WAIT_MS = 25_000;
const RETRY_MS = 5_000;

interface FeedEvent extends WireEvent {
  row?: Record<string, unknown>;
  row_id?: string;
  violations_total?: number;
}

interface FeedAnswer {
  events: FeedEvent[];
  last: number;
  head: number;
  gap?: boolean;
}

interface Filters {
  tables: string[];
  kinds: string[];
  columns: string;
  exclude_actor: string;
  auth: string;
  session: string;
  where: unknown;
}

const EMPTY: Filters = { tables: [], kinds: [], columns: "", exclude_actor: "", auth: "", session: "", where: undefined };

function argsOf(f: Filters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.tables.length) out.tables = f.tables;
  if (f.kinds.length) out.kinds = f.kinds;
  const cols = f.columns
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (cols.length) out.columns = cols;
  if (f.exclude_actor.trim()) out.exclude_actor = f.exclude_actor.trim();
  if (f.auth.trim()) out.auth = f.auth.trim();
  if (f.session.trim()) out.session = f.session.trim();
  if (f.where !== undefined) out.where = f.where;
  return out;
}

function violationCount(e: FeedEvent): number {
  if (typeof e.violations_total === "number") return e.violations_total;
  return (e.violations ?? []).reduce<number>((n, v) => {
    const inner = (v as { violations?: unknown[] }).violations;
    return n + (Array.isArray(inner) ? inner.length : 1);
  }, 0);
}

function EventDetail(props: { e: FeedEvent }): JSX.Element {
  const { e } = props;
  const changes = Object.entries(e.changes ?? {});
  return (
    <div class="history-event-detail">
      <p class="ui-muted history-small">
        seq {e.seq} · {e.path}
        {e.old_path ? ` (was ${e.old_path})` : ""}
        {e.op ? ` · ${e.op}` : ""}
        {e.migration_id ? ` · ${e.migration_id}` : ""}
        {e.actor?.session ? ` · session ${e.actor.session}` : ""}
      </p>
      {changes.length ? (
        <table class="history-diff-cols">
          <thead>
            <tr>
              <th>Column</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {changes.map(([col, c]) => (
              <tr key={col}>
                <td>
                  <code>{col}</code>
                </td>
                <td class="history-before">
                  <ValueView value={c.before} fromPath={e.path} />
                </td>
                <td class="history-after">
                  <ValueView value={c.after} fromPath={e.path} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {e.row ? (
        <details>
          <summary>Row</summary>
          <pre class="ui-json-out">{JSON.stringify(e.row, null, 2)}</pre>
        </details>
      ) : null}
      {e.violations && e.violations.length ? (
        <details open>
          <summary>Violations</summary>
          <pre class="ui-json-out">{JSON.stringify(e.violations, null, 2)}</pre>
        </details>
      ) : null}
      {e.call ? (
        <details>
          <summary>Call</summary>
          <pre class="ui-json-out">{JSON.stringify(e.call, null, 2)}</pre>
        </details>
      ) : null}
      {e.table && e.kind !== "delete" && e.kind !== "tool_call" && e.kind !== "metastore" ? (
        <a href={href("row", { table: e.table }, { path: e.path })}>Open the row</a>
      ) : null}
    </div>
  );
}

/** The change feed: filters, latest or from a number, more, live updates. */
export function ChangesScreen(props: { route: Route }): JSX.Element {
  const { api, catalog } = useApp();
  const [tables, setTables] = useState<string[]>([]);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [whereError, setWhereError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [startText, setStartText] = useState(props.route.query.since ?? "");
  const [start, setStart] = useState<number | null>(/^\d+$/.test(props.route.query.since ?? "") ? Number(props.route.query.since) : null);
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [head, setHead] = useState(0);
  const [gap, setGap] = useState(false);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  useEffect(() => {
    let alive = true;
    catalog
      .load()
      .then((tree) => {
        if (!alive) return;
        setTables(tree.catalogs.flatMap((c) => c.schemas.flatMap((s) => s.tables.map((t) => t.qualified))));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [catalog]);

  // the first page: the latest changes, or from the number asked for
  useEffect(() => {
    let alive = true;
    setEvents(null);
    setError(null);
    setGap(false);
    const run = async () => {
      let since = start;
      if (since === null) {
        const h = await api.op<FeedAnswer>("list_changes", { since: 0, limit: 1 });
        if (!h.ok) throw h.json;
        since = Math.max(0, h.json.head - PAGE);
      }
      const a = await api.op<FeedAnswer>("list_changes", { ...argsOf(filters), since, limit: PAGE });
      if (!a.ok) throw a.json;
      if (!alive) return;
      setEvents([...a.json.events].reverse());
      setCursor(a.json.last);
      setHead(a.json.head);
      setGap(a.json.gap === true);
    };
    run().catch((e: unknown) => alive && setError(errorBodyOf(e)));
    return () => {
      alive = false;
    };
  }, [api, filters, start]);

  // live: a long poll of its own with the same filters, newest at the top
  useEffect(() => {
    if (!live || events === null) return;
    const ctl = new AbortController();
    let alive = true;
    const loop = async () => {
      while (alive) {
        try {
          const a = await api.op<FeedAnswer>("list_changes", { ...argsOf(filters), since: cursorRef.current, wait_ms: WAIT_MS, limit: 500 }, ctl.signal);
          if (!alive) return;
          if (a.ok) {
            cursorRef.current = a.json.last;
            setCursor(a.json.last);
            setHead(a.json.head);
            if (a.json.gap) setGap(true);
            if (a.json.events.length) setEvents((prev) => [...[...a.json.events].reverse(), ...(prev ?? [])]);
          } else {
            await new Promise((r) => setTimeout(r, RETRY_MS));
          }
        } catch (e) {
          if (!alive || e instanceof AuthRefused) return;
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
    };
    void loop();
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [api, live, filters, events === null]);

  const more = async () => {
    setLoading(true);
    try {
      const a = await api.op<FeedAnswer>("list_changes", { ...argsOf(filters), since: cursor, limit: PAGE });
      if (!a.ok) {
        setError(errorBodyOf(a.json));
        return;
      }
      setEvents((prev) => [...[...a.json.events].reverse(), ...(prev ?? [])]);
      setCursor(a.json.last);
      setHead(a.json.head);
      if (a.json.gap) setGap(true);
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setLoading(false);
    }
  };

  const apply = () => {
    if (whereError) return;
    setFilters(draft);
    setStart(/^\d+$/.test(startText.trim()) ? Number(startText.trim()) : null);
  };

  const toggle = (seq: number) => {
    const next = new Set(open);
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    setOpen(next);
  };

  const toggleKind = (k: string) =>
    setDraft({ ...draft, kinds: draft.kinds.includes(k) ? draft.kinds.filter((x) => x !== k) : [...draft.kinds, k] });

  return (
    <div class="history-screen">
      <h1>Change feed</h1>
      <form class="history-filters history-filters-wide" onSubmit={(e) => e.preventDefault()}>
        <label class="ui-field">
          <span>Tables</span>
          <select
            multiple
            size={Math.min(6, Math.max(2, tables.length))}
            onChange={(e) => setDraft({ ...draft, tables: Array.from(e.currentTarget.selectedOptions).map((o) => o.value) })}
          >
            {tables.map((t) => (
              <option key={t} value={t} selected={draft.tables.includes(t)}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <fieldset class="history-kinds">
          <legend>Kinds</legend>
          {KINDS.map((k) => (
            <label key={k}>
              <input type="checkbox" checked={draft.kinds.includes(k)} onChange={() => toggleKind(k)} /> {k}
            </label>
          ))}
        </fieldset>
        <label class="ui-field">
          <span>Columns (comma separated)</span>
          <input type="text" spellcheck={false} value={draft.columns} onInput={(e) => setDraft({ ...draft, columns: e.currentTarget.value })} />
        </label>
        <label class="ui-field">
          <span>Leave out the harness</span>
          <input type="text" spellcheck={false} value={draft.exclude_actor} onInput={(e) => setDraft({ ...draft, exclude_actor: e.currentTarget.value })} />
        </label>
        <label class="ui-field">
          <span>Credential</span>
          <input type="text" spellcheck={false} value={draft.auth} onInput={(e) => setDraft({ ...draft, auth: e.currentTarget.value })} />
        </label>
        <label class="ui-field">
          <span>Session</span>
          <input type="text" spellcheck={false} value={draft.session} onInput={(e) => setDraft({ ...draft, session: e.currentTarget.value })} />
        </label>
        <label class="ui-field">
          <span>From change number (empty: the latest {PAGE})</span>
          <input type="text" inputMode="numeric" value={startText} onInput={(e) => setStartText(e.currentTarget.value)} />
        </label>
        <div class="history-where">
          <JsonEditor
            label="where (as in select_rows, on the values after the change)"
            rows={3}
            value={draft.where}
            onChange={(v, err) => {
              setWhereError(err);
              setDraft({ ...draft, where: v });
            }}
          />
        </div>
        <div class="history-filter-buttons">
          <Button kind="primary" disabled={whereError !== null} onClick={apply}>
            Show
          </Button>
          <Button
            onClick={() => {
              setDraft(EMPTY);
              setFilters(EMPTY);
              setStartText("");
              setStart(null);
            }}
          >
            Clear
          </Button>
          <label class="history-live">
            <input type="checkbox" checked={live} onChange={() => setLive(!live)} /> Live
          </label>
        </div>
      </form>
      {gap ? (
        <p>
          <Badge kind="warn">gap</Badge> Older changes were dropped from the feed: re-read the tables.
        </p>
      ) : null}
      {error ? (
        <ErrorBox body={error} />
      ) : !events ? (
        <Spinner />
      ) : (
        <>
          <div class="history-feed-bar">
            <span class="ui-muted">
              {events.length} change{events.length === 1 ? "" : "s"} shown, up to number {cursor} of {head}.
            </span>
            {cursor < head ? (
              <Button disabled={loading} onClick={() => void more()}>
                More
              </Button>
            ) : null}
            {live ? <Spinner label="Waiting for changes…" /> : null}
          </div>
          {events.length === 0 ? (
            <EmptyState title="No change matches." />
          ) : (
            <ul class="history-feed">
              {events.map((e) => {
                const n = violationCount(e);
                return (
                  <li key={e.seq} class="history-event">
                    <button type="button" class="history-event-head" aria-expanded={open.has(e.seq)} onClick={() => toggle(e.seq)}>
                      <span class="history-nowrap" title={formatTime(e.at)}>
                        {relativeTime(e.at)}
                      </span>
                      <span class="history-event-summary">{changeSummary(e)}</span>
                      <span class="ui-muted">{actorLabel(e.actor)}</span>
                      <Badge kind={e.source === "external" ? "warn" : "info"}>{e.source === "external" ? "hand edit" : "engine"}</Badge>
                      {n > 0 ? <Badge kind="error">{n} violation{n === 1 ? "" : "s"}</Badge> : null}
                    </button>
                    {open.has(e.seq) ? <EventDetail e={e} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
