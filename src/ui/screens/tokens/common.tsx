// Helpers shared by the token, matrix and user screens.
import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { ErrorBox, errorBodyOf, Spinner } from "../../components";
import type { ApiAnswer, ErrorBody } from "../../lib/api";
import type { CatalogTree } from "../../lib/catalog";

export interface Loaded<T> {
  data: T | null;
  error: ErrorBody | null;
  reload(): void;
}

/** One call, run on mount and on reload(); a non-2xx answer becomes the error. */
export function useAnswer<T>(call: () => Promise<ApiAnswer<T>>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    call()
      .then((a) => {
        if (!live) return;
        if (a.ok) setData(a.json);
        else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [...deps, round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { data, error, reload };
}

/** The error, else a spinner until the data is there, else the children. */
export function Show<T>(props: { loaded: Loaded<T>; children: (data: T) => ComponentChildren }): JSX.Element {
  if (props.loaded.error) return <ErrorBox body={props.loaded.error} />;
  if (props.loaded.data === null) return <Spinner />;
  return <>{props.children(props.loaded.data)}</>;
}

/** A token entry of /tokens/ (PublicToken of src/server/tokens.ts). */
export interface TokenEntry {
  name: string;
  description?: string;
  read: string[];
  write: string[];
  ddl: boolean;
  maintain?: boolean;
  autolink?: boolean;
  created_at: string;
  updated_at: string;
  last_seen?: string;
}

/** One session of /sessions/. */
export interface SessionEntry {
  token: string;
  session: string | null;
  harness?: string;
  model?: string;
  first_at: string;
  last_at: string;
  first_seq: number;
  last_seq: number;
  tool_call_count: number;
  failed_tool_call_count: number;
  row_change_count: number;
  migration_count: number;
  tables: string[];
  tools: { tool: string; call_count: number }[];
}

/** The qualified names of every table of the catalog. */
export function tableNames(tree: CatalogTree): string[] {
  return tree.catalogs.flatMap((c) => c.schemas.flatMap((s) => s.tables.map((t) => t.qualified))).sort();
}

export const DAY_MS = 86_400_000;

/** An ISO time this long ago. */
export function ago(ms: number, now: number = Date.now()): string {
  return new Date(now - ms).toISOString();
}

/** A list of patterns as text. */
export function patternsText(list: readonly string[] | undefined): string {
  return list && list.length ? list.join(", ") : "—";
}

/** Does a session of /sessions/ match a session of the URL ("-": the work without a session)? */
export function sameSession(s: SessionEntry, param: string): boolean {
  if (param === "-") return s.session === null;
  return s.session !== null && (s.session === param || s.session.slice(0, 16) === param.slice(0, 16));
}
