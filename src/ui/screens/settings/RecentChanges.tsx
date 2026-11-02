import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { EmptyState, ErrorBox, errorBodyOf, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { formatTime, settingChangeText } from "../../lib/format";
import { useApp } from "../../state";

interface Entry {
  migration_id: string;
  executed_at?: string;
  by?: string;
  actor?: { auth?: string; harness?: string; model?: string };
  settings?: { name: string; before?: unknown; after?: unknown; redacted?: boolean }[];
}

/** Who changed which setting, from the journal (op set_engine_settings), newest first. */
function whoOf(e: Entry): string {
  const a = e.actor;
  if (a?.auth) return [a.auth, a.harness, a.model].filter((x): x is string => typeof x === "string" && x !== "").join(" · ");
  return e.by ?? "";
}

export function RecentChanges(props: { reloadKey: number }): JSX.Element {
  const { api } = useApp();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .op<{ migrations?: Entry[] }>("list_migrations", { op: "set_engine_settings", limit: 10 })
      .then((a) => {
        if (!live) return;
        if (a.ok) setEntries(a.json.migrations ?? []);
        else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, props.reloadKey]);

  return (
    <section class="settings-recent">
      <h2>Recent changes</h2>
      {error ? <ErrorBox body={error} /> : entries === null ? <Spinner /> : entries.length === 0 ? <EmptyState title="No change of the settings in the journal" /> : null}
      {entries && entries.length > 0 ? (
        <ul>
          {entries.map((e) => (
            <li key={e.migration_id}>
              <span class="settings-recent-time">{e.executed_at ? formatTime(e.executed_at) : ""}</span> <span class="ui-muted">{whoOf(e)}</span>
              <ul>
                {(e.settings ?? []).map((c) => (
                  <li key={c.name}>
                    <code>{settingChangeText(c)}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
