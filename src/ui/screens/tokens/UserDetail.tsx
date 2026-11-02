import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, DataTable, EmptyState, ErrorBox, errorBodyOf, Spinner, Tabs } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { formatTime, settingChangeText, undoable } from "../../lib/format";
import { href, navigate, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { ago, DAY_MS, patternsText, Show, useAnswer, type SessionEntry, type TokenEntry } from "./common";

const WINDOWS: { id: string; label: string; ms: number }[] = [
  { id: "24h", label: "24 hours", ms: DAY_MS },
  { id: "7d", label: "7 days", ms: 7 * DAY_MS },
  { id: "30d", label: "30 days", ms: 30 * DAY_MS },
];

/** #/users/<name>: what a credential may do, its sessions and its writes. */
export function UserScreen(props: { route: Route }): JSX.Element {
  const { api } = useApp();
  const name = props.route.params.name ?? "";
  const [tab, setTab] = useState("sessions");
  const tokens = useAnswer(() => api.route<{ tokens: TokenEntry[] }>("/tokens/"), [api]);

  return (
    <div class="tokens-screen">
      <p>
        <a href={href("users")}>Users</a> / <code>{name}</code>
      </p>
      <h1>{name}</h1>
      {name === "owner" ? (
        <p>Everything: the owner reads and writes every table, and runs the engine.</p>
      ) : (
        <Show loaded={tokens}>
          {(data) => {
            const t = data.tokens.find((x) => x.name === name);
            if (!t) return <p class="ui-muted">No token {name} now: it was deleted. Its past sessions and writes are below.</p>;
            return (
              <p>
                Reads {t.read.includes("*") ? "every table" : patternsText(t.read)}; writes {patternsText(t.write)}
                {t.ddl ? "; ddl" : ""}
                {t.maintain ? "; maintain" : ""}. <a href={href("token", { name })}>Edit the token</a>
              </p>
            );
          }}
        </Show>
      )}
      <Tabs
        tabs={[
          { id: "sessions", label: "Sessions" },
          { id: "writes", label: "Writes" },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === "sessions" ? <Sessions name={name} /> : <Writes name={name} />}
    </div>
  );
}

function Sessions(props: { name: string }): JSX.Element {
  const { api } = useApp();
  const [win, setWin] = useState("7d");
  const ms = (WINDOWS.find((w) => w.id === win) ?? WINDOWS[1]!).ms;
  const loaded = useAnswer(() => api.route<{ since: string; sessions: SessionEntry[] }>("/sessions/", { token: props.name, since: ago(ms), limit: 1000 }), [api, props.name, ms]);
  return (
    <div>
      <label class="tokens-inline">
        Window{" "}
        <select value={win} onChange={(e) => setWin(e.currentTarget.value)}>
          {WINDOWS.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
      </label>
      <Show loaded={loaded}>
        {(data) =>
          data.sessions.length === 0 ? (
            <EmptyState title="No sessions in this window" />
          ) : (
            <DataTable
              rows={data.sessions as unknown as Record<string, unknown>[]}
              rowKey={(r) => String(r.session ?? "-")}
              onRowClick={(r) => navigate("session", { name: props.name, session: typeof r.session === "string" ? r.session : "-" })}
              columns={[
                {
                  key: "session",
                  label: "Session",
                  render: (r) => (
                    <a href={href("session", { name: props.name, session: typeof r.session === "string" ? r.session : "-" })}>
                      {typeof r.session === "string" ? r.session : "(no session)"}
                    </a>
                  ),
                },
                { key: "harness", label: "Harness" },
                { key: "model", label: "Model" },
                { key: "first_at", label: "First", render: (r) => formatTime(String(r.first_at)) },
                { key: "last_at", label: "Last", render: (r) => formatTime(String(r.last_at)) },
                { key: "tool_call_count", label: "Tool calls (failed)", render: (r) => `${String(r.tool_call_count)} (${String(r.failed_tool_call_count)})` },
                { key: "row_change_count", label: "Row changes" },
                { key: "migration_count", label: "Migrations" },
                { key: "tables", label: "Tables", render: (r) => (r.tables as string[]).join(", ") },
              ]}
            />
          )
        }
      </Show>
    </div>
  );
}

interface Migration extends Record<string, unknown> {
  migration_id: string;
  op: string;
  summary?: string;
  table?: string;
  executed_at: string;
  files_changed?: number;
  undone?: boolean;
  settings?: { name: string; before?: unknown; after?: unknown; redacted?: boolean }[];
}

const PAGE = 100;

function Writes(props: { name: string }): JSX.Element {
  const { api, toast } = useApp();
  const [rows, setRows] = useState<Migration[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = async (before: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const a = await api.op<{ total: number; migrations: Migration[] }>("list_migrations", { auth: props.name, limit: PAGE, ...(before ? { before } : {}) });
      if (!a.ok) {
        setError(errorBodyOf(a.json));
        return;
      }
      setTotal(a.json.total);
      setRows((old) => (before && old ? [...old, ...a.json.migrations] : a.json.migrations));
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load(null);
  }, [api, props.name, round]);

  const undo = async (m: Migration) => {
    try {
      const a = await api.op<{ error?: string; hint?: string }>("undo_migration", { migration_id: m.migration_id });
      if (a.ok) {
        toast({ text: "Undone", kind: "ok" });
        setRound((n) => n + 1);
      } else if (a.status === 409) toast({ text: a.json.hint ?? a.json.error ?? "The engine cannot undo this write.", kind: "error" });
      else setError(errorBodyOf(a.json));
    } catch (e) {
      setError(errorBodyOf(e));
    }
  };

  if (error && !rows) return <ErrorBox body={error} />;
  if (!rows) return <Spinner />;
  const last = rows[rows.length - 1];
  return (
    <div>
      <ErrorBox body={error} />
      {rows.length === 0 ? (
        <EmptyState title={`No writes by ${props.name} in the journal`}>The journal keeps 90 days.</EmptyState>
      ) : (
        <DataTable
          rows={rows}
          rowKey={(r) => String(r.migration_id)}
          columns={[
            { key: "executed_at", label: "When", render: (r) => formatTime(String(r.executed_at)) },
            { key: "op", label: "Operation", render: (r) => <code>{String(r.op)}</code> },
            {
              key: "summary",
              label: "Summary",
              render: (r) => {
                const m = r as Migration;
                if (m.op === "set_engine_settings" && m.settings) {
                  return (
                    <ul class="tokens-settings">
                      {m.settings.map((c) => (
                        <li key={c.name}>{settingChangeText(c)}</li>
                      ))}
                    </ul>
                  );
                }
                return m.summary ?? "";
              },
            },
            { key: "table", label: "Table" },
            { key: "files_changed", label: "Files changed" },
            {
              key: "undo",
              label: "",
              render: (r) => {
                const m = r as Migration;
                if (m.undone) return <span class="ui-muted">undone</span>;
                return undoable(m.op) ? <Button onClick={() => void undo(m)}>Undo</Button> : null;
              },
            },
          ]}
        />
      )}
      {last && rows.length < total ? (
        <Button disabled={busy} onClick={() => void load(last.executed_at)}>
          Older
        </Button>
      ) : null}
    </div>
  );
}
