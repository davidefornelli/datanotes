import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBox, errorBodyOf, Spinner } from "../components";
import type { ErrorBody } from "../lib/api";
import type { CatalogTree } from "../lib/catalog";
import { href, type RouteName } from "../lib/router";
import { useApp } from "../state";

function matches(filter: string, name: string, aliases?: string[]): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return name.toLowerCase().includes(f) || (aliases ?? []).some((a) => a.toLowerCase().includes(f));
}

interface NavLink {
  name: RouteName;
  label: string;
  owner?: boolean;
}

const LINKS: NavLink[][] = [
  [
    { name: "tokens", label: "Tokens", owner: true },
    { name: "matrix", label: "Permission matrix", owner: true },
    { name: "users", label: "Users and sessions", owner: true },
  ],
  [
    { name: "journal", label: "Journal" },
    { name: "changes", label: "Change feed" },
    { name: "database-history", label: "Database history" },
  ],
  [
    { name: "config", label: "Configuration" },
    { name: "settings", label: "Engine settings", owner: true },
    { name: "webhooks", label: "Webhooks" },
    { name: "extensions", label: "Extensions" },
    { name: "status", label: "Status", owner: true },
    { name: "semantic", label: "Semantic index" },
    { name: "maintenance", label: "Maintenance" },
  ],
  [{ name: "ops", label: "Operations" }],
];

/** The tree of the database (catalog, schema, tables, views; bases) and the links to every screen. */
export function Sidebar(): JSX.Element {
  const { catalog, isOwner, viewAs, readOnly } = useApp();
  const [tree, setTree] = useState<CatalogTree | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let live = true;
    const load = () => {
      catalog
        .load()
        .then((t) => {
          if (!live) return;
          setTree(t);
          setError(null);
        })
        .catch((e: unknown) => live && setError(errorBodyOf(e)));
    };
    load();
    const off = catalog.subscribe(load);
    return () => {
      live = false;
      off();
    };
  }, [catalog]);

  const ownerView = isOwner && !viewAs;
  return (
    <nav class="shell-sidebar" aria-label="Database">
      <input
        type="search"
        class="shell-filter"
        placeholder="Filter tables and views"
        aria-label="Filter tables and views"
        value={filter}
        onInput={(e) => setFilter(e.currentTarget.value)}
      />
      {error ? <ErrorBox body={error} /> : null}
      {!tree && !error ? <Spinner /> : null}
      {tree ? (
        <div class="shell-tree">
          {tree.catalogs.map((c) => (
            <details key={c.catalog} open>
              <summary title={c.description}>
                {c.catalog}
                {c.default ? <span class="ui-muted"> (default)</span> : null}
              </summary>
              {c.schemas.map((s) => {
                const tables = s.tables.filter((t) => matches(filter, t.name, t.aliases));
                const views = s.views.filter((v) => matches(filter, v.name, v.aliases));
                return (
                  <details key={s.schema} open class="shell-schema">
                    <summary title={s.description}>{s.schema}</summary>
                    <p class="shell-group">Tables</p>
                    <ul>
                      {tables.map((t) => (
                        <li key={t.qualified} title={t.description}>
                          <a href={href("rows", { object: t.qualified })}>{t.name}</a>
                          {t.row_count !== undefined ? <span class="shell-count">{t.row_count}</span> : null}
                          <a class="shell-structure" href={href("table", { table: t.qualified })} title="Structure">
                            ⚙
                          </a>
                        </li>
                      ))}
                      {tables.length === 0 ? <li class="ui-muted">none</li> : null}
                    </ul>
                    <p class="shell-group">Views</p>
                    <ul>
                      {views.map((v) => (
                        <li key={v.qualified} title={v.description}>
                          <a href={href("rows", { object: v.qualified })}>{v.name}</a>
                          <a class="shell-structure" href={href("view", { view: v.qualified })} title="Structure">
                            ⚙
                          </a>
                        </li>
                      ))}
                      {views.length === 0 ? <li class="ui-muted">none</li> : null}
                    </ul>
                  </details>
                );
              })}
            </details>
          ))}
          <details open>
            <summary>Bases</summary>
            <ul>
              {tree.bases
                .filter((b) => matches(filter, b.name))
                .map((b) => (
                  <li key={b.name} title={b.description}>
                    <a href={href("base", { name: b.name })}>{b.name}</a>
                  </li>
                ))}
              {tree.bases.length === 0 ? <li class="ui-muted">none</li> : null}
            </ul>
          </details>
        </div>
      ) : null}
      {!readOnly ? (
        <div class="shell-new">
          <a href={href("new-table")}>New table</a>
          <a href={href("new-view")}>New view</a>
        </div>
      ) : null}
      {LINKS.map((group, i) => {
        const shown = group.filter((l) => !l.owner || ownerView);
        return shown.length ? (
          <ul key={i} class="shell-links">
            {shown.map((l) => (
              <li key={l.name}>
                <a href={href(l.name)}>{l.label}</a>
              </li>
            ))}
          </ul>
        ) : null;
      })}
    </nav>
  );
}
