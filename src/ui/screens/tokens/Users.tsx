import type { JSX } from "preact";
import { DataTable, ErrorBox } from "../../components";
import { formatTime, relativeTime } from "../../lib/format";
import { href, navigate, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { Show, useAnswer, type SessionEntry, type TokenEntry } from "./common";

interface UserRow extends Record<string, unknown> {
  name: string;
  description: string;
  last_seen: string | null;
  sessions: number;
  last_activity: string | null;
}

function time(iso: string | null, now: number): JSX.Element | string {
  return iso ? <span title={formatTime(iso)}>{relativeTime(iso, now)}</span> : "—";
}

/** #/users: the owner and every token, with their agent sessions of the last 7 days. */
export function UsersScreen(_props: { route: Route }): JSX.Element {
  const { api } = useApp();
  const tokens = useAnswer(() => api.route<{ tokens: TokenEntry[] }>("/tokens/"), [api]);
  // the engine's default window: the last 7 days
  const sessions = useAnswer(() => api.route<{ since: string; sessions: SessionEntry[] }>("/sessions/", { limit: 1000 }), [api]);
  const now = Date.now();

  return (
    <div class="tokens-screen">
      <h1>Users and sessions</h1>
      <p class="ui-muted">Who did what: the owner and every named token, with the agent sessions that used them.</p>
      {sessions.error ? <ErrorBox title="Sessions are not available" body={sessions.error} /> : null}
      <Show loaded={tokens}>
        {(data) => {
          const list = sessions.data?.sessions ?? [];
          const row = (name: string, description: string, lastSeen: string | null): UserRow => {
            const mine = list.filter((s) => s.token === name);
            const last = mine.reduce<string | null>((m, s) => (m === null || s.last_at > m ? s.last_at : m), null);
            return { name, description, last_seen: lastSeen, sessions: mine.length, last_activity: last };
          };
          const rows: UserRow[] = [row("owner", "The owner's token: everything", null), ...data.tokens.map((t) => row(t.name, t.description ?? "", t.last_seen ?? null))];
          return (
            <DataTable
              rows={rows}
              rowKey={(r) => String(r.name)}
              onRowClick={(r) => navigate("user", { name: String(r.name) })}
              columns={[
                { key: "name", label: "Name", render: (r) => <a href={href("user", { name: String(r.name) })}>{String(r.name)}</a> },
                { key: "description", label: "Description" },
                { key: "last_seen", label: "Last seen", render: (r) => time(r.last_seen as string | null, now) },
                { key: "sessions", label: "Sessions (7 days)", render: (r) => (sessions.data ? String(r.sessions) : "…") },
                { key: "last_activity", label: "Last activity", render: (r) => time(r.last_activity as string | null, now) },
              ]}
            />
          );
        }}
      </Show>
    </div>
  );
}
