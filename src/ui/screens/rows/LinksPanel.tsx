import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { EmptyState, ErrorBox, errorBodyOf, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { basename } from "../../lib/format";
import { href } from "../../lib/router";
import { useApp } from "../../state";
import { bodyOf } from "./common";

interface Edge {
  path: string;
  table?: string;
  label?: string;
  direction?: "out" | "in";
}

function EdgeList(props: { title: string; edges: Edge[] }): JSX.Element {
  return (
    <div class="rows-links-group">
      <h3>
        {props.title} ({props.edges.length})
      </h3>
      {props.edges.length === 0 ? (
        <p class="ui-muted">None</p>
      ) : (
        <ul>
          {props.edges.map((e, i) => (
            <li key={`${e.path}-${e.label ?? ""}-${i}`}>
              <a href={href("open", {}, { path: e.path })} title={e.path}>
                {basename(e.path)}
              </a>{" "}
              {e.label ? <span class="ui-muted">via {e.label}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The notes a note links to and the notes that link to it (graph_neighbors, both directions). */
export function LinksPanel(props: { path: string }): JSX.Element {
  const { api } = useApp();
  const [edges, setEdges] = useState<Edge[] | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);

  useEffect(() => {
    let live = true;
    setEdges(null);
    setError(null);
    api
      .op<{ nodes?: { edges?: Edge[] }[] }>("graph_neighbors", { from_nodes: { paths: [props.path] }, direction: "both" })
      .then((a) => {
        if (!live) return;
        if (!a.ok) setError(bodyOf(a));
        else setEdges(a.json.nodes?.[0]?.edges ?? []);
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, props.path]);

  if (error) return <ErrorBox body={error} />;
  if (!edges) return <Spinner />;
  if (edges.length === 0) return <EmptyState title="No links to or from this note" />;
  return (
    <div class="rows-links">
      <EdgeList title="Links out" edges={edges.filter((e) => e.direction !== "in")} />
      <EdgeList title="Links in" edges={edges.filter((e) => e.direction === "in")} />
    </div>
  );
}
