// A table's relations: the links it makes (its columns) and the links other tables make to it, from
// describe_table of every table (at most 4 calls at a time).

import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { EmptyState, ErrorBox, errorBodyOf, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { href } from "../../lib/router";
import { incoming, outgoing, type Relation } from "../../lib/relations";
import { useApp } from "../../state";
import type { Described } from "./shared";

const PARALLEL = 4;

function RelationList(props: { title: string; relations: Relation[]; from: boolean }): JSX.Element {
  return (
    <div class="schema-relations-list">
      <h2>{props.title}</h2>
      {props.relations.length === 0 ? (
        <EmptyState title="None." />
      ) : (
        <ul>
          {props.relations.map((r) => {
            const other = props.from ? r.ref : r.table;
            return (
              <li key={`${r.table}.${r.column}`}>
                <code>
                  {props.from ? "" : `${r.table}.`}
                  {r.column}
                </code>{" "}
                {r.list ? "(list of links) " : ""}
                {props.from ? "→ " : "← "}
                {other ? <a href={href("table", { table: other })}>{other}</a> : <span class="ui-muted">any note</span>}
                {r.inverse ? (
                  <span class="ui-muted">
                    {" "}
                    inverse <code>{r.inverse}</code>
                  </span>
                ) : null}
                {r.hierarchy ? <span class="ui-muted"> hierarchy</span> : null}
                {r.ref_by !== undefined ? <span class="ui-muted"> ref_by</span> : null}
                {r.ref_where !== undefined ? <span class="ui-muted"> ref_where</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function RelationsTab(props: { data: Described }): JSX.Element {
  const { catalog } = useApp();
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [found, setFound] = useState<Relation[] | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const target = props.data.qualified;

  useEffect(() => {
    let live = true;
    setFound(null);
    setError(null);
    (async () => {
      const tree = await catalog.load();
      const names = tree.catalogs.flatMap((c) => c.schemas.flatMap((s) => s.tables.map((t) => t.qualified)));
      const described: { qualified: string; columns: Record<string, unknown>[] }[] = [];
      let next = 0;
      let done = 0;
      if (live) setProgress({ done, total: names.length });
      const worker = async () => {
        while (live && next < names.length) {
          const name = names[next++]!;
          const a = await catalog.describe(name);
          if (a.ok) described.push({ qualified: name, columns: ((a.json as { columns?: Record<string, unknown>[] }).columns ?? []) });
          done++;
          if (live) setProgress({ done, total: names.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, names.length) }, worker));
      if (live) setFound(incoming(target, described));
    })().catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [catalog, target]);

  return (
    <div class="schema-relations">
      <RelationList title="Links from this table" relations={outgoing(target, props.data.columns)} from />
      {error ? (
        <ErrorBox body={error} />
      ) : found ? (
        <RelationList title="Links to this table" relations={found} from={false} />
      ) : (
        <Spinner label={`Reading the tables: ${progress.done} of ${progress.total}`} />
      )}
    </div>
  );
}
