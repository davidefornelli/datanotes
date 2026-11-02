import type { ComponentChildren, JSX } from "preact";
import { Badge, Button, ErrorBox, Spinner } from "../../components";
import { formatTime, relativeTime } from "../../lib/format";
import type { Route } from "../../lib/router";
import { href } from "../../lib/router";
import { useApp } from "../../state";
import { useLoad } from "./use-load";

interface Status {
  healthy: boolean;
  problems: string[];
  engine: {
    version: string;
    pid: number | null;
    host_name: string | null;
    started_at: string;
    uptime_s: number;
    http: { host: string; port: number | null };
    watch: string | null;
    vault: string | null;
    settings_file: string | null;
    store: string | null;
    database_id: string | null;
    database_folder: string;
  };
  database: {
    metastore: string;
    readable: boolean;
    error?: string;
    tables: number;
    views: number;
    history_tables: number;
    journal: { window_hours: number; operations: number; last: { op: string; summary: string; executed_at: string; by?: string } | null };
  };
  git_sync: { enabled: boolean; repo?: string; last_run_at?: string; last_commit?: string; last_push_at?: string; blocked?: string; pending_operations: number } | null;
  store_backup: {
    enabled: boolean;
    interval_s: number;
    remote: string | null;
    last_commit?: string;
    last_commit_at?: string;
    last_push_at?: string;
    pending_operations: number;
    pending_commits: number;
    last_error?: string;
    hint?: string;
  } | null;
  change_feed: { running: boolean; reason?: string; head: number | null };
  webhooks: { count: number; failing: { id: string; url_host: string; failures: number; last_error?: string }[] };
  tokens: { name: string; write: string[]; ddl: boolean; maintain: boolean; last_seen: string | null }[];
  hand_edits: { window_hours: number; checked: boolean; reason?: string; edits?: number; rows?: number; violations?: number; latest?: { path: string; at: string; violations: number; message: string }[] };
  logs: { folder: string | null; console_log: string | null; telemetry: string | null };
}

function uptime(s: number): string {
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
}

const text = (v: unknown) => (v === null || v === undefined || v === "" ? "–" : String(v));
const at = (v: string | undefined) => (v ? `${formatTime(v)} (${relativeTime(v)})` : "–");

function Card(props: { title: string; badge?: ComponentChildren; children: ComponentChildren }): JSX.Element {
  return (
    <section class="admin-card">
      <h2>
        {props.title} {props.badge}
      </h2>
      {props.children}
    </section>
  );
}

function Facts(props: { rows: [string, ComponentChildren][] }): JSX.Element {
  return (
    <dl class="admin-facts">
      {props.rows.map(([k, v]) => (
        <>
          <dt key={`k-${k}`}>{k}</dt>
          <dd key={`v-${k}`}>{v}</dd>
        </>
      ))}
    </dl>
  );
}

export function StatusScreen(_props: { route: Route }): JSX.Element {
  const { api } = useApp();
  const { data: s, error, reload } = useLoad<Status>(() => api.route<Status>("/status/"), [api], { every: 30_000 });

  if (error && !s) return <ErrorBox body={error} />;
  if (!s) return <Spinner />;
  const h = s.hand_edits;
  const e = s.engine;
  const b = s.store_backup;

  return (
    <div class="admin-screen">
      <div class="admin-head">
        <h1>Status</h1>
        <Button onClick={reload}>Refresh</Button>
      </div>
      <ErrorBox body={error} />
      <div class="admin-grid">
        <Card title="Health" badge={<Badge kind={s.healthy ? "ok" : "error"}>{s.healthy ? "healthy" : "needs attention"}</Badge>}>
          {s.problems.length === 0 ? (
            <p class="ui-muted">No problems.</p>
          ) : (
            <ul class="admin-list">
              {s.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Engine">
          <Facts
            rows={[
              ["Version", e.version],
              ["Uptime", uptime(e.uptime_s)],
              ["Started", at(e.started_at)],
              ["Address", `${e.http.host}${e.http.port ? `:${e.http.port}` : ""}`],
              ["Host", text(e.host_name)],
              ["Process", text(e.pid)],
              ["Vault", text(e.vault)],
              ["Watching", text(e.watch)],
              ["Store", text(e.store)],
              ["Settings file", text(e.settings_file)],
            ]}
          />
        </Card>
        <Card title="Database" badge={<Badge kind={s.database.readable ? "ok" : "error"}>{s.database.readable ? "readable" : "unreadable"}</Badge>}>
          <Facts
            rows={[
              ["Folder", e.database_folder],
              ["Id", text(e.database_id)],
              ["Tables", String(s.database.tables)],
              ["Views", String(s.database.views)],
              ["Tables with history", String(s.database.history_tables)],
              [`Operations, last ${s.database.journal.window_hours} h`, String(s.database.journal.operations)],
              [
                "Last operation",
                s.database.journal.last
                  ? `${s.database.journal.last.op}: ${s.database.journal.last.summary} (${relativeTime(s.database.journal.last.executed_at)}${s.database.journal.last.by ? `, by ${s.database.journal.last.by}` : ""})`
                  : "–",
              ],
              ...(s.database.error ? ([["Error", s.database.error]] as [string, string][]) : []),
            ]}
          />
        </Card>
        <Card title="Git sync" badge={s.git_sync ? <Badge kind={s.git_sync.blocked ? "error" : s.git_sync.enabled ? "ok" : "warn"}>{s.git_sync.blocked ? "blocked" : s.git_sync.enabled ? "on" : "off"}</Badge> : <Badge kind="info">off</Badge>}>
          {s.git_sync ? (
            <Facts
              rows={[
                ["Repository", text(s.git_sync.repo)],
                ["Last run", at(s.git_sync.last_run_at)],
                ["Last commit", text(s.git_sync.last_commit)],
                ["Last push", at(s.git_sync.last_push_at)],
                ["Pending operations", String(s.git_sync.pending_operations)],
                ...(s.git_sync.blocked ? ([["Blocked", s.git_sync.blocked]] as [string, string][]) : []),
              ]}
            />
          ) : (
            <p class="ui-muted">Git sync is off.</p>
          )}
        </Card>
        <Card title="Store backup" badge={b ? <Badge kind={b.last_error ? "error" : b.enabled ? "ok" : "warn"}>{b.last_error ? "failing" : b.enabled ? "on" : "off"}</Badge> : <Badge kind="info">off</Badge>}>
          {b ? (
            <Facts
              rows={[
                ["Every", `${b.interval_s} s`],
                ["Remote", text(b.remote)],
                ["Last commit", at(b.last_commit_at)],
                ["Last push", at(b.last_push_at)],
                ["Pending commits", String(b.pending_commits)],
                ...(b.last_error ? ([["Error", b.last_error]] as [string, string][]) : []),
                ...(b.hint ? ([["Hint", b.hint]] as [string, string][]) : []),
              ]}
            />
          ) : (
            <p class="ui-muted">The store backup is off.</p>
          )}
        </Card>
        <Card title="Change feed" badge={<Badge kind={s.change_feed.running ? "ok" : "error"}>{s.change_feed.running ? "running" : "stopped"}</Badge>}>
          <Facts rows={[["Head", text(s.change_feed.head)], ...(s.change_feed.reason ? ([["Reason", s.change_feed.reason]] as [string, string][]) : [])]} />
        </Card>
        <Card title="Webhooks" badge={<Badge kind={s.webhooks.failing.length ? "error" : "ok"}>{s.webhooks.failing.length ? `${s.webhooks.failing.length} failing` : "none failing"}</Badge>}>
          <p>{s.webhooks.count} in all.</p>
          {s.webhooks.failing.length > 0 ? (
            <ul class="admin-list">
              {s.webhooks.failing.map((w) => (
                <li key={w.id}>
                  {w.id} ({w.url_host}): {w.failures} failures{w.last_error ? `, ${w.last_error}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        <Card title="Tokens">
          {s.tokens.length === 0 ? (
            <p class="ui-muted">No named tokens.</p>
          ) : (
            <ul class="admin-list">
              {s.tokens.map((t) => (
                <li key={t.name}>
                  {t.name}: {t.last_seen ? `seen ${relativeTime(t.last_seen)}` : "never seen"}
                  {t.ddl ? ", schema" : ""}
                  {t.maintain ? ", maintain" : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Hand edits" badge={h.checked ? <Badge kind={(h.rows ?? 0) > 0 ? "warn" : "ok"}>{(h.rows ?? 0) > 0 ? `${h.rows} rows break rules` : "no problems"}</Badge> : <Badge kind="warn">not checked</Badge>}>
          {!h.checked ? (
            <p class="ui-muted">{h.reason ?? "Not checked."}</p>
          ) : (
            <>
              <p>
                {h.edits ?? 0} in the last {h.window_hours} h; {h.violations ?? 0} violations.
              </p>
              {(h.latest ?? []).length > 0 ? (
                <ul class="admin-list">
                  {(h.latest ?? []).map((x) => (
                    <li key={x.path}>
                      <a href={href("open", {}, { path: x.path })}>{x.path}</a>: {x.message} ({relativeTime(x.at)})
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </Card>
        <Card title="Logs">
          <Facts rows={[["Folder", text(s.logs.folder)], ["Console log", text(s.logs.console_log)], ["Telemetry", text(s.logs.telemetry)]]} />
        </Card>
      </div>
    </div>
  );
}
