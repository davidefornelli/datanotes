import { Fragment, type JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Badge, Button, EmptyState, ErrorBox, errorBodyOf, Modal, OperationForm, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { formatTime, relativeTime, settingChangeText, undoable } from "../../lib/format";
import { actorLabel, groupBatches, nextBefore, type ActorLike } from "../../lib/history";
import { href, navigate, type Route } from "../../lib/router";
import { useApp } from "../../state";

export interface Migration {
  migration_id: string;
  op: string;
  summary: string;
  table?: string;
  executed_at: string;
  notes_changed: number;
  files_changed: number;
  undone: boolean;
  undoes?: string;
  files_failed: number;
  by?: string;
  actor?: ActorLike;
  members?: string[];
  batch?: string;
  settings?: { name: string; before?: unknown; after?: unknown; redacted?: boolean }[];
}

const PAGE = 100;
const FILTERS = ["op", "table", "since", "auth"] as const;

/** Whether the signed-in credential may rewind the database: the owner, or a token with `maintain`. */
export function useMaintain(): boolean {
  const { api, isOwner, readOnly } = useApp();
  const [maintain, setMaintain] = useState(false);
  useEffect(() => {
    if (isOwner || readOnly) return;
    let live = true;
    api
      .route<{ entry?: { maintain?: unknown } | null }>("/tokens/me/")
      .then((a) => live && a.ok && setMaintain(a.json.entry?.maintain === true))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, isOwner, readOnly]);
  return !readOnly && (isOwner || maintain);
}

function filtersOf(query: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FILTERS) if (query[k]) out[k] = query[k]!;
  return out;
}

function State(props: { m: Migration }): JSX.Element {
  const { m } = props;
  return (
    <span class="history-state">
      {m.undone ? <Badge kind="warn">undone</Badge> : null}
      {m.undoes ? <Badge kind="info" title={m.undoes}>undoes an operation</Badge> : null}
      {m.files_failed > 0 ? <Badge kind="error">{m.files_failed} failed</Badge> : null}
    </span>
  );
}

interface RowProps {
  m: Migration;
  child?: boolean;
  open: boolean;
  onToggle?(): void;
  canWrite: boolean;
  canRewind: boolean;
  busy: boolean;
  onUndo(m: Migration): void;
  onRewind(m: Migration): void;
  isOwner: boolean;
}

function JournalRow(props: RowProps): JSX.Element {
  const { m } = props;
  const expandable = Boolean(props.onToggle);
  return (
    <>
      <tr class={props.child ? "history-child" : undefined}>
        <td class="history-nowrap" title={m.executed_at}>
          {expandable ? (
            <button type="button" class="history-toggle" aria-expanded={props.open} onClick={props.onToggle}>
              {props.open ? "▾" : "▸"}
            </button>
          ) : null}
          {formatTime(m.executed_at)}
          <div class="ui-muted">{relativeTime(m.executed_at)}</div>
        </td>
        <td>
          <code>{m.op}</code>
        </td>
        <td>{m.summary}</td>
        <td>{m.table ? <a href={href("table-history", { table: m.table })}>{m.table}</a> : null}</td>
        <td title={m.actor?.session ? `session ${m.actor.session}` : undefined}>{actorLabel(m.actor, m.by)}</td>
        <td class="history-num">{m.notes_changed}</td>
        <td class="history-num">{m.files_changed}</td>
        <td>
          <State m={m} />
        </td>
        <td class="history-actions">
          {!undoable(m.op) ? (
            <Badge kind="info">cannot be undone</Badge>
          ) : (
            <>
              {props.canWrite && !m.undone ? (
                <Button disabled={props.busy} onClick={() => props.onUndo(m)}>
                  Undo
                </Button>
              ) : null}
              {props.canRewind ? (
                <Button kind="plain" onClick={() => props.onRewind(m)} title="restore_database with before_migration">
                  Rewind the database to before this…
                </Button>
              ) : null}
            </>
          )}
        </td>
      </tr>
      {props.open && m.settings ? (
        <tr class="history-detail">
          <td colSpan={9}>
            <ul class="history-settings">
              {m.settings.map((s) => (
                <li key={s.name}>
                  <code>{settingChangeText(s)}</code>
                </li>
              ))}
            </ul>
            {props.isOwner ? <a href={href("settings")}>Open the engine settings</a> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The operation journal: filters in the hash, older pages, batches grouped, undo and rewind. */
export function JournalScreen(props: { route: Route }): JSX.Element {
  const { api, readOnly, isOwner, viewAs, toast } = useApp();
  const canRewind = useMaintain();
  const filters = filtersOf(props.route.query);
  const key = JSON.stringify(filters);
  const [rows, setRows] = useState<Migration[] | null>(null);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState<string | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [actionError, setActionError] = useState<ErrorBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [rewind, setRewind] = useState<Migration | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>(filters);
  const [reload, setReload] = useState(0);

  const load = async (before: string | null, live: () => boolean) => {
    setLoading(true);
    try {
      const args: Record<string, unknown> = { limit: PAGE, ...filters };
      if (before) args.before = before;
      const a = await api.op<{ total: number; migrations: Migration[] }>("list_migrations", args);
      if (!live()) return;
      if (!a.ok) {
        setError(errorBodyOf(a.json));
        return;
      }
      setError(null);
      setTotal(a.json.total);
      setRows((prev) => (before && prev ? [...prev, ...a.json.migrations] : a.json.migrations));
      setMore(nextBefore(a.json.migrations, PAGE));
    } catch (e) {
      if (live()) setError(errorBodyOf(e));
    } finally {
      if (live()) setLoading(false);
    }
  };

  useEffect(() => {
    let live = true;
    setRows(null);
    setDraft(filters);
    void load(null, () => live);
    return () => {
      live = false;
    };
  }, [api, key, reload]);

  const undo = async (m: Migration) => {
    setBusy(true);
    setActionError(null);
    try {
      const a = await api.op("undo_migration", { migration_id: m.migration_id });
      if (a.ok) {
        toast({ text: "Undone", kind: "ok" });
        setReload((n) => n + 1);
      } else setActionError(errorBodyOf(a.json));
    } catch (e) {
      setActionError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = (e: Event) => {
    e.preventDefault();
    navigate("journal", {}, draft, true);
  };

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  const grouped = rows ? groupBatches(rows) : [];
  const rowProps = { canWrite: !readOnly, canRewind, busy, onUndo: (m: Migration) => void undo(m), onRewind: setRewind, isOwner: isOwner && !viewAs };

  return (
    <div class="history-screen">
      <h1>Journal</h1>
      <form class="history-filters" onSubmit={apply}>
        {FILTERS.map((k) => (
          <label key={k} class="ui-field">
            <span>{k === "since" ? "since (ISO date)" : k === "auth" ? "credential" : k}</span>
            <input type="text" spellcheck={false} value={draft[k] ?? ""} onInput={(e) => setDraft({ ...draft, [k]: e.currentTarget.value })} />
          </label>
        ))}
        <div class="history-filter-buttons">
          <Button kind="primary" onClick={() => navigate("journal", {}, draft, true)}>
            Filter
          </Button>
          <Button onClick={() => navigate("journal", {}, {}, true)}>Clear</Button>
        </div>
      </form>
      <ErrorBox body={actionError} title="The engine did not undo it" />
      {error ? (
        <ErrorBox body={error} />
      ) : !rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No operation in the journal matches." />
      ) : (
        <>
          <p class="ui-muted">
            {rows.length} of {total} operations.
          </p>
          <div class="ui-table-wrap">
            <table class="ui-table history-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Operation</th>
                  <th>Summary</th>
                  <th>Table</th>
                  <th>Who</th>
                  <th>Notes</th>
                  <th>Files</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) => {
                  const expandable = g.children.length > 0 || Boolean(g.settings);
                  const isOpen = open.has(g.migration_id);
                  return (
                    <Fragment key={g.migration_id}>
                      <JournalRow m={g} open={isOpen} onToggle={expandable ? () => toggle(g.migration_id) : undefined} {...rowProps} />
                      {isOpen ? g.children.map((c) => <JournalRow key={c.migration_id} m={c} child open={false} {...rowProps} />) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {more ? (
            <Button disabled={loading} onClick={() => void load(more, () => true)}>
              Older
            </Button>
          ) : null}
          {loading ? <Spinner /> : null}
        </>
      )}
      {rewind ? (
        <Modal title="Rewind the database" onClose={() => setRewind(null)} wide>
          <p>
            Every table with a log goes back to how it was just before <code>{rewind.migration_id}</code> ({rewind.summary}). The rewind is
            one operation: you can undo it.
          </p>
          <OperationForm
            op="restore_database"
            fixed={{ before_migration: rewind.migration_id }}
            hide={["timestamp"]}
            confirm={`Rewind every table to before ${rewind.migration_id}? Rows written since then change or go away.`}
            onDone={(a) => a.ok && setReload((n) => n + 1)}
          />
        </Modal>
      ) : null}
    </div>
  );
}
