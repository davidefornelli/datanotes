import type { JSX } from "preact";
import { displayValue } from "../lib/format";
import { summarize, type Violation, type WriteAnswer } from "../lib/write-result";
import { Badge } from "./Badge";
import { docsLink } from "./ErrorBox";

function violationText(v: Violation): string {
  const where = v.column ?? (v.constraint ? `CHECK ${v.constraint}` : v.code);
  const value = v.value === undefined ? "" : ` (value: ${displayValue(v.value)})`;
  return `${where}: ${v.message}${value}`;
}

function List(props: { title: string; items: string[] }): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <div class="ui-write-list">
      <p class="ui-write-list-title">{props.title}</p>
      <ul>
        {props.items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** What a write did, would do, or why the engine refused it. */
export function WriteResult(props: { answer: WriteAnswer; status: number }): JSX.Element {
  const a = props.answer;
  const kind = !a.ok ? "error" : a.dry_run ? "info" : "ok";
  const docs = docsLink(a.docs);
  return (
    <div class={`ui-write ui-write-${kind}`}>
      <p class="ui-write-summary">
        <Badge kind={kind}>{a.ok ? (a.dry_run ? "Dry run" : "Done") : `Refused (HTTP ${props.status})`}</Badge> {summarize(a)}
        {a.rolled_back ? " (rolled back)" : ""}
      </p>
      {a.violations.map((entry) => (
        <List key={`v-${entry.path}`} title={`Violations in ${entry.path}`} items={(entry.violations ?? []).map(violationText)} />
      ))}
      <List title="Conflicts" items={a.conflicts.map((c) => `${c.path}: ${c.message}`)} />
      <List title="Failed" items={(a.failed ?? []).map((f) => `${f.path}: ${f.error}`)} />
      {a.dry_run ? (
        <>
          <List
            title="Edits"
            items={(a.planned_edits ?? []).map((e) => {
              const parts = [
                e.set ? `set ${JSON.stringify(e.set)}` : "",
                e.remove?.length ? `remove ${e.remove.join(", ")}` : "",
                e.body !== undefined ? "new body" : "",
              ].filter(Boolean);
              return `${e.path}${parts.length ? `: ${parts.join("; ")}` : ""}`;
            })}
          />
          <List title="Files to create" items={a.planned_creates ?? []} />
          <List title="Files to move" items={(a.planned_moves ?? []).map((m) => `${m.from} → ${m.to}`)} />
          <List title="Files to delete" items={a.planned_deletes ?? []} />
        </>
      ) : null}
      <List title="Links added" items={(a.links_added ?? []).map(asText)} />
      <List title="Ambiguous mentions" items={(a.ambiguous_mentions ?? []).map(asText)} />
      <List title="Warnings" items={(a.warnings ?? []).map(asText)} />
      {a.hint ? <p class="ui-error-hint">{a.hint}</p> : null}
      {docs ? (
        <p class="ui-error-docs">
          <a href={docs} target="_blank" rel="noopener noreferrer">
            Read more in the docs
          </a>
        </p>
      ) : null}
    </div>
  );
}
