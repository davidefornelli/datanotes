// Loads one answer of the engine for a screen: data, the error to show, and a reload. A new call
// supersedes the one before; an unmounted screen ignores its answer.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ApiAnswer, ErrorBody } from "../../lib/api";
import { errorBodyOf } from "../../components";

export interface Loaded<T> {
  data: T | null;
  error: ErrorBody | null;
  loading: boolean;
  reload(): void;
}

export function useLoad<T>(call: () => Promise<ApiAnswer<T>>, deps: unknown[], opts: { every?: number } = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(call);
  latest.current = call;
  const seen = useRef(false);

  useEffect(() => {
    let live = true;
    // a reload keeps what is shown; a new request (new deps) starts clean
    if (!seen.current) setLoading(true);
    latest
      .current()
      .then((a) => {
        if (!live) return;
        seen.current = true;
        if (a.ok) {
          setData(a.json);
          setError(null);
        } else {
          setError(errorBodyOf(a.json));
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(errorBodyOf(e));
        setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  // a timed refresh runs only while the page is visible
  useEffect(() => {
    if (!opts.every) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, opts.every);
    return () => clearInterval(id);
  }, [opts.every]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
