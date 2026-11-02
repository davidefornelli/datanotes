import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { EmptyState, ErrorBox, errorBodyOf, OperationForm, Spinner } from "../components";
import type { ErrorBody } from "../lib/api";
import { href, type Route } from "../lib/router";
import { operationsOf } from "../lib/schema-forms";
import { useApp } from "../state";

type Entry = { op: string; tag: string; summary: string };

/** #/ops: every operation of the engine, by tag; #/ops/<op>: a form that runs it. */
export function OpsScreen(props: { route: Route }): JSX.Element {
  const { api } = useApp();
  const [ops, setOps] = useState<Entry[] | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [filter, setFilter] = useState("");
  const current = props.route.name === "op" ? props.route.params.op ?? "" : null;

  useEffect(() => {
    let live = true;
    api
      .openapi()
      .then((doc) => live && setOps(operationsOf(doc)))
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api]);

  if (error) return <ErrorBox body={error} />;
  if (!ops) return <Spinner />;

  if (current !== null) {
    const entry = ops.find((o) => o.op === current);
    return (
      <div class="shell-ops">
        <p>
          <a href={href("ops")}>Operations</a> / <code>{current}</code>
        </p>
        <h1>{current}</h1>
        {entry ? <p class="ui-muted">{entry.summary}</p> : null}
        <OperationForm key={current} op={current} />
      </div>
    );
  }

  const f = filter.toLowerCase();
  const shown = ops.filter((o) => !f || o.op.includes(f) || o.summary.toLowerCase().includes(f));
  const tags: string[] = [];
  for (const o of shown) if (!tags.includes(o.tag)) tags.push(o.tag);
  return (
    <div class="shell-ops">
      <h1>Operations</h1>
      <p class="ui-muted">Every operation of the engine. Writes offer a dry run first.</p>
      <input type="search" placeholder="Filter operations" aria-label="Filter operations" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
      {shown.length === 0 ? <EmptyState title="No operation matches" /> : null}
      {tags.map((tag) => (
        <section key={tag}>
          <h2>{tag}</h2>
          <ul class="shell-ops-list">
            {shown
              .filter((o) => o.tag === tag)
              .map((o) => (
                <li key={o.op}>
                  <a href={href("op", { op: o.op })}>
                    <code>{o.op}</code>
                  </a>{" "}
                  <span class="ui-muted">{o.summary}</span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
