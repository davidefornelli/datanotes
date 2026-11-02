// What the row editor and the new-row form share: the body editor, the engine's refusal shown
// around the form, and the result of a write.

import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { ErrorBox, Tabs } from "../../components";
import { MarkdownView } from "../../markdown/MarkdownView";
import { resolveLink } from "../../lib/open";
import { navigate } from "../../lib/router";
import { summarize, violationsFor, type Violation, type WriteAnswer } from "../../lib/write-result";
import { useApp } from "../../state";
import { opOf } from "./common";

/** A refused write, split for the form: messages under each field, CHECKs above, the rest in a box. */
export interface Refusal {
  byColumn: Record<string, Violation[]>;
  checks: Violation[];
  other: Violation[];
  /** Conflicts that are not "row changed". */
  conflicts: { path: string; message: string }[];
  /** A "row changed" conflict: the row or its body changed since it was read. */
  rowChanged: boolean;
  answer: WriteAnswer;
}

export function refusalOf(a: WriteAnswer, path?: string): Refusal {
  const v = violationsFor(a, path);
  const changed = a.conflicts.filter((c) => c.message.startsWith("row changed"));
  return {
    ...v,
    conflicts: a.conflicts.filter((c) => !c.message.startsWith("row changed")),
    rowChanged: changed.length > 0,
    answer: a,
  };
}

/** The CHECK box, the other violations and conflicts, the hint and the docs of a refusal. */
export function RefusalView(props: { refusal: Refusal; hints: Record<string, string>; status: number }): JSX.Element {
  const r = props.refusal;
  const a = r.answer;
  const lines = [...r.other.map((v) => v.message), ...r.conflicts.map((c) => c.message), ...(a.failed ?? []).map((f) => `${f.path}: ${f.error}`)];
  const unshown = Object.keys(r.byColumn).length === 0 && r.checks.length === 0 && lines.length === 0;
  return (
    <>
      {r.checks.length ? (
        <div class="rows-checks" role="alert">
          <p class="rows-checks-title">The row breaks {r.checks.length === 1 ? "a CHECK constraint" : `${r.checks.length} CHECK constraints`}</p>
          <ul>
            {r.checks.map((c, i) => (
              <li key={i}>
                <strong>{c.constraint ?? "check"}</strong>: {c.message}
                {c.constraint && props.hints[c.constraint] ? <p class="ui-error-hint">{props.hints[c.constraint]}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {lines.length || unshown || a.hint || a.docs ? (
        <ErrorBox
          title={`${summarize(a)} (HTTP ${props.status})${a.rolled_back ? ", rolled back" : ""}`}
          body={{ error: lines.length ? lines.join("\n") : unshown ? summarize(a) : "See the messages in the form.", ...(a.hint ? { hint: a.hint } : {}), ...(a.docs ? { docs: a.docs } : {}) }}
        />
      ) : null}
    </>
  );
}

/** The messages of one column: the form's format error, then the engine's. */
export function fieldErrors(name: string, formErrors: Record<string, string>, refusal: Refusal | null): string[] {
  const out: string[] = [];
  if (formErrors[name]) out.push(formErrors[name]!);
  for (const v of refusal?.byColumn[name] ?? []) out.push(v.message);
  return out;
}

/** The note's text: a monospace editor and a preview whose links open in the browser. */
export function BodyEditor(props: { value: string; onChange(v: string): void; fromPath?: string; disabled?: boolean }): JSX.Element {
  const { api, toast } = useApp();
  const [tab, setTab] = useState("edit");
  const openLink = async (target: string) => {
    if (!props.fromPath) {
      navigate("open", {}, { link: target });
      return;
    }
    const path = await resolveLink(opOf(api), props.fromPath, target).catch(() => null);
    if (path) navigate("open", {}, { path });
    else toast({ text: `No note matches ${target}`, kind: "error" });
  };
  return (
    <div class="rows-body">
      <Tabs
        tabs={[
          { id: "edit", label: "Edit" },
          { id: "preview", label: "Preview" },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === "edit" ? (
        <textarea class="rows-body-text rows-mono" aria-label="Body" spellcheck={false} rows={14} disabled={props.disabled} value={props.value} onInput={(e) => props.onChange(e.currentTarget.value)} />
      ) : (
        <MarkdownView text={props.value} onOpenLink={(t) => void openLink(t)} />
      )}
    </div>
  );
}

