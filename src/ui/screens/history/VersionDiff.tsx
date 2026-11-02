import type { JSX } from "preact";
import { EmptyState, ValueView } from "../../components";
import { basename } from "../../lib/format";
import type { RowDiff } from "../../lib/history";
import { href } from "../../lib/router";

const KIND_TEXT: Record<RowDiff["kind"], string> = {
  insert: "added",
  delete: "removed",
  update: "changed",
  metadata: "definition changed",
};

/** The row changes between two versions of a table: per row, the changed columns before → after. */
export function VersionDiff(props: { diffs: RowDiff[]; table: string }): JSX.Element {
  if (props.diffs.length === 0) return <EmptyState title="No row changed between these versions." />;
  return (
    <div class="history-diff">
      {props.diffs.map((d, i) => (
        <section key={`${d.version ?? ""}:${d.path}:${i}`} class={`history-diff-row history-diff-${d.kind}`}>
          <header>
            <strong>{KIND_TEXT[d.kind]}</strong>{" "}
            {d.path ? (
              <a href={href("row", { table: props.table }, { path: d.path })} title={d.path}>
                {basename(d.path)}
              </a>
            ) : (
              <span class="ui-muted">the table's definition</span>
            )}
            {d.version !== undefined ? <span class="ui-muted"> · version {d.version}</span> : null}
          </header>
          {d.changed.length ? (
            <table class="history-diff-cols">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {d.changed.map((c) => (
                  <tr key={c}>
                    <td>
                      <code>{c}</code>
                    </td>
                    <td class="history-before">{d.before ? <ValueView value={d.before[c]} /> : null}</td>
                    <td class="history-after">{d.after ? <ValueView value={d.after[c]} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ))}
    </div>
  );
}
