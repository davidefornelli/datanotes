// A base: the shared columns tables inherit, its member tables, and define_base to change it.

import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { DataTable, EmptyState, ErrorBox, errorBodyOf, OperationForm, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import type { BaseEntry } from "../../lib/catalog";
import { specFromColumn } from "../../lib/column-spec";
import { displayValue } from "../../lib/format";
import { href, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { typeText } from "./ColumnsTab";
import { Section } from "./shared";

export function BaseScreen(props: { route: Route }): JSX.Element {
  const name = props.route.params.name ?? "";
  const { catalog, readOnly } = useApp();
  const [base, setBase] = useState<BaseEntry | null | undefined>(undefined);
  const [specs, setSpecs] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const tree = await catalog.load();
      const b = tree.bases.find((x) => x.name === name) ?? null;
      if (!live) return;
      setBase(b);
      setSpecs(null);
      const first = b?.tables[0];
      if (b && first) {
        // the full specs: the first member table describes the inherited columns
        const a = await catalog.describe(first);
        const cols = ((a.json as { columns?: Record<string, unknown>[] }).columns ?? []).filter((c) => b.columns.includes(String(c.name)));
        if (live) setSpecs(cols.map(specFromColumn));
      } else if (live) setSpecs([]);
      if (live) setRound((n) => n + 1);
    };
    const run = () => void load().catch((e: unknown) => live && setError(errorBodyOf(e)));
    run();
    const off = catalog.subscribe(run);
    return () => {
      live = false;
      off();
    };
  }, [catalog, name]);

  if (error) return <ErrorBox body={error} />;
  if (base === undefined) return <Spinner />;
  if (base === null) return <EmptyState title={`No base named ${name}.`} />;
  return (
    <div class="schema-base">
      <header class="schema-head">
        <h1>Base {base.name}</h1>
        <nav class="schema-links">
          <a href={href("rows", { object: `base:${base.name}` })}>Browse rows</a>
        </nav>
      </header>
      <p>{base.description ?? <span class="ui-muted">no description</span>}</p>
      <h2>Member tables</h2>
      {base.tables.length ? (
        <ul>
          {base.tables.map((t) => (
            <li key={t}>
              <a href={href("table", { table: t })}>{t}</a>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No table inherits this base." />
      )}
      <h2>Columns</h2>
      {specs === null ? (
        <Spinner />
      ) : specs.length ? (
        <DataTable
          columns={[
            { key: "name", label: "Name", render: (c) => <code>{String(c.name)}</code> },
            { key: "type", label: "Type", render: typeText },
            { key: "required", label: "Required", render: (c) => (c.required ? "yes" : "") },
            { key: "ref", label: "Links to", render: (c) => displayValue(c.ref) },
            { key: "description", label: "Description", render: (c) => displayValue(c.description) },
          ]}
          rows={specs}
          rowKey={(c) => String(c.name)}
        />
      ) : (
        <p>{base.columns.join(", ")}</p>
      )}
      {readOnly || specs === null ? null : (
        <Section title="Edit (define_base)">
          <p class="ui-muted">Replacing a base changes every table that inherits it: list renamed columns in rename_columns, dropped ones in drop_columns.</p>
          <OperationForm
            key={round}
            op="define_base"
            initial={{ name: base.name, description: base.description, columns: specs }}
            onDone={(a) => a.ok && (a.json as { dry_run?: unknown }).dry_run !== true && void catalog.refresh().catch(() => undefined)}
          />
        </Section>
      )}
    </div>
  );
}
