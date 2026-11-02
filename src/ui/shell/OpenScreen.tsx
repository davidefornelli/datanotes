import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { EmptyState, ErrorBox, errorBodyOf, Spinner } from "../components";
import type { ErrorBody } from "../lib/api";
import { linkTarget } from "../lib/format";
import { resolveLink, tableOfPath } from "../lib/open";
import { navigate, type Route } from "../lib/router";
import { useApp } from "../state";

/** #/open: a path, or a link from a note, opened as its row (a table's) or as a plain note. */
export function OpenScreen(props: { route: Route }): JSX.Element {
  const { api } = useApp();
  const { path, from, link } = props.route.query;
  const [missing, setMissing] = useState<string | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);

  useEffect(() => {
    let live = true;
    setMissing(null);
    setError(null);
    const op = (name: string, args?: Record<string, unknown>) => api.op(name, args);
    (async () => {
      let target: string | null = path ?? null;
      if (!target && link) target = from ? await resolveLink(op, from, link) : linkTarget(link) ?? link;
      if (!live) return;
      if (!target) {
        setMissing(link ?? "");
        return;
      }
      const table = await tableOfPath(op, target);
      if (!live) return;
      if (table) navigate("row", { table }, { path: target }, true);
      else navigate("note", {}, { path: target }, true);
    })().catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, path, from, link]);

  if (error) return <ErrorBox body={error} />;
  if (missing !== null) return <EmptyState title={missing ? `No note matches ${missing}` : "Nothing to open"} />;
  return <Spinner label="Opening…" />;
}
