import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { basename } from "../lib/format";
import { navigate } from "../lib/router";
import { useApp } from "../state";

interface Hit {
  path: string;
  context: string;
}

/** Full-text search of the notes (search_notes): at least 2 characters, 300 ms after typing stops. */
export function Search(): JSX.Element {
  const { api } = useApp();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [note, setNote] = useState("");
  const counter = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const n = ++counter.current;
    if (q.length < 2) {
      setHits([]);
      setNote("");
      return;
    }
    const timer = setTimeout(() => {
      api
        .op<{ results?: { path: string; matches?: { context?: string }[] }[]; error?: string }>("search_notes", { query: q, context_length: 60 })
        .then((a) => {
          if (n !== counter.current) return;
          if (!a.ok) {
            setHits([]);
            setNote(a.json.error ?? `Search failed (HTTP ${a.status})`);
            return;
          }
          const list = (a.json.results ?? []).slice(0, 10).map((r) => ({ path: r.path, context: r.matches?.[0]?.context ?? "" }));
          setHits(list);
          setActive(0);
          setNote(list.length ? "" : "No note matches.");
          setOpen(true);
        })
        .catch((e: unknown) => {
          if (n === counter.current) setNote(e instanceof Error ? e.message : String(e));
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, api]);

  const go = (h: Hit | undefined) => {
    if (!h) return;
    setOpen(false);
    navigate("open", {}, { path: h.path });
  };

  return (
    <div class="shell-search">
      <input
        type="search"
        placeholder="Search notes"
        aria-label="Search notes"
        value={query}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "Enter") go(hits[active]);
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(active + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(active - 1, 0));
          }
        }}
      />
      {open && (hits.length || note) ? (
        <ul class="shell-search-results" role="listbox">
          {hits.map((h, i) => {
            const slash = h.path.lastIndexOf("/");
            return (
              <li
                key={h.path}
                role="option"
                aria-selected={i === active}
                class={i === active ? "shell-search-active" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(h);
                }}
              >
                <span class="shell-search-name">{basename(h.path)}</span>
                <span class="shell-search-folder">{slash > 0 ? h.path.slice(0, slash) : ""}</span>
                {h.context ? <span class="shell-search-context">{h.context}</span> : null}
              </li>
            );
          })}
          {note ? <li class="shell-search-note">{note}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
