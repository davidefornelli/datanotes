import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Badge, ErrorBox, errorBodyOf, Spinner } from "../components";
import type { ErrorBody } from "../lib/api";
import { displayValue } from "../lib/format";
import { href } from "../lib/router";
import { useApp } from "../state";

interface Database {
  root?: string;
  metastore?: string;
  config?: Record<string, unknown>;
  catalogs?: { catalog: string; description?: string; default?: boolean; schemas?: { tables?: unknown[]; views?: unknown[] }[] }[];
  bases?: unknown[];
}

interface Status {
  healthy?: boolean;
  problems?: unknown[];
}

/** The database at a glance: where it lives, its defaults, what it holds; for the owner, its health. */
export function Home(): JSX.Element {
  const { api, isOwner, viewAs } = useApp();
  const [db, setDb] = useState<Database | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let live = true;
    setDb(null);
    setError(null);
    setStatus(null);
    api
      .op<Database & { error?: string }>("describe_database")
      .then((a) => {
        if (!live) return;
        if (a.ok) setDb(a.json);
        else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    if (isOwner && !viewAs) {
      api
        .route<Status>("/status/")
        .then((a) => live && a.ok && setStatus(a.json))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [api, isOwner, viewAs]);

  if (error) return <ErrorBox body={error} />;
  if (!db) return <Spinner />;
  const schemas = (db.catalogs ?? []).flatMap((c) => c.schemas ?? []);
  const tables = schemas.reduce((n, s) => n + (s.tables?.length ?? 0), 0);
  const views = schemas.reduce((n, s) => n + (s.views?.length ?? 0), 0);
  const config = db.config ?? {};
  const facts: [string, unknown][] = [
    ["Database folder", db.root],
    ["Metastore", db.metastore],
    ["Default catalog", config.default_catalog],
    ["Default schema", config.default_schema],
    ["Time zone", config.timezone],
    ["History", config.history],
    ["Automatic links", config.autolink],
  ];
  return (
    <div class="shell-home">
      <h1>Database</h1>
      {status ? (
        <p>
          {status.healthy ? <Badge kind="ok">healthy</Badge> : <Badge kind="error">problems</Badge>}{" "}
          {status.problems?.length ? (
            <a href={href("status")}>
              {status.problems.length} problem{status.problems.length === 1 ? "" : "s"}: see Status
            </a>
          ) : (
            <a href={href("status")}>Status</a>
          )}
        </p>
      ) : null}
      <dl class="shell-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{displayValue(v) || <span class="ui-muted">not set</span>}</dd>
          </div>
        ))}
      </dl>
      <p>
        {tables} table{tables === 1 ? "" : "s"}, {views} view{views === 1 ? "" : "s"}, {db.bases?.length ?? 0} base
        {db.bases?.length === 1 ? "" : "s"}.
      </p>
      <h2>Catalogs</h2>
      <ul>
        {(db.catalogs ?? []).map((c) => (
          <li key={c.catalog}>
            <strong>{c.catalog}</strong>
            {c.default ? <span class="ui-muted"> (default)</span> : null}
            {c.description ? `: ${c.description}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
