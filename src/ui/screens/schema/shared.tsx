// Pieces the structure screens share: a DDL runner (Check, then Apply, the result, the toast with
// Undo, the catalog refreshed), the described table loader, and small inputs.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button, ConfirmDialog, ErrorBox, errorBodyOf, Spinner, WriteResult } from "../../components";
import type { ApiAnswer, ErrorBody } from "../../lib/api";
import { undoable } from "../../lib/format";
import { isWriteAnswer } from "../../lib/write-result";
import { useApp } from "../../state";

/** describe_table's answer, as far as the screens read it. */
export interface Described {
  qualified: string;
  name: string;
  catalog: string;
  schema: string;
  description?: string;
  aliases?: string[];
  layout?: Record<string, unknown>;
  options?: Record<string, unknown>;
  columns: Record<string, unknown>[];
  untyped_fields?: string[];
  row_count?: number;
  tags?: Record<string, string>;
  bases?: string[];
  constraints?: Record<string, unknown>;
  constraint_hints?: Record<string, string>;
  instructions?: string;
  row_template?: string;
  history?: unknown;
  autolink_target?: unknown;
  fields?: Record<string, unknown>;
  missing_descriptions?: { table: boolean; columns: string[] };
}

/** One answer of a call: the WriteResult of a write, else the engine's error, else the JSON. */
export function AnswerView(props: { answer: ApiAnswer }): JSX.Element {
  const { answer } = props;
  const j = answer.json;
  if (isWriteAnswer(j)) return <WriteResult answer={j} status={answer.status} />;
  if (!answer.ok) return <ErrorBox body={errorBodyOf(j)} title={`HTTP ${answer.status}`} />;
  return <pre class="ui-json-out">{JSON.stringify(j, null, 2)}</pre>;
}

export interface DdlRunnerProps {
  op: string;
  /** The arguments without dry_run; null while the form cannot be sent. */
  args: Record<string, unknown> | null;
  /** Why the form cannot be sent (shown, buttons disabled). */
  problems?: string[];
  /** The user types this text before Apply (a table or column name). */
  requireText?: string;
  /** Asks before Apply, with this message. */
  confirmMessage?: ComponentChildren;
  applyLabel?: string;
  /** No Check button (the operation has no dry_run). */
  noDryRun?: boolean;
  /** After an applied write; the catalog is already refreshed. */
  onApplied?(answer: ApiAnswer): void;
}

/** Check (dry run), then Apply: each answer shown; an applied write toasts with Undo and refreshes the catalog. */
export function DdlRunner(props: DdlRunnerProps): JSX.Element | null {
  const { api, toast, catalog, readOnly } = useApp();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ApiAnswer | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [confirming, setConfirming] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  if (readOnly) return <p class="ui-muted">Read only while you view as a token.</p>;
  const blocked = props.args === null || (props.problems?.length ?? 0) > 0;

  const run = async (dryRun: boolean) => {
    if (!props.args) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const args: Record<string, unknown> = { ...props.args };
      if (!props.noDryRun) args.dry_run = dryRun;
      const a = await api.op(props.op, args);
      if (!live.current) return;
      setAnswer(a);
      const id = (a.json as { migration_id?: unknown }).migration_id;
      if (a.ok && !dryRun) {
        toast({ text: "Done", kind: "ok", ...(typeof id === "string" && undoable(props.op) ? { undo: id } : {}) });
        await catalog.refresh().catch(() => undefined);
        props.onApplied?.(a);
      }
    } catch (e) {
      if (live.current) setError(errorBodyOf(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const apply = () => {
    if (props.requireText !== undefined || props.confirmMessage !== undefined) setConfirming(true);
    else void run(false);
  };

  return (
    <div class="schema-ddl">
      {props.problems?.length ? (
        <ul class="schema-problems">
          {props.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div class="ui-opform-buttons">
        {props.noDryRun ? null : (
          <Button disabled={busy || blocked} onClick={() => void run(true)}>
            Check (dry run)
          </Button>
        )}
        <Button kind={props.requireText !== undefined ? "danger" : "primary"} disabled={busy || blocked} onClick={apply}>
          {props.applyLabel ?? "Apply"}
        </Button>
        {busy ? <Spinner label="Running…" /> : null}
      </div>
      <ErrorBox body={error} />
      {answer ? <AnswerView answer={answer} /> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Run ${props.op}?`}
          message={props.confirmMessage ?? <p>This changes the database's structure.</p>}
          confirmLabel={props.applyLabel ?? "Apply"}
          danger={props.requireText !== undefined}
          requireText={props.requireText}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** describe_table of one table through the catalog cache; `reload` drops the cache first. */
export function useDescribed(table: string): {
  data: Described | null;
  error: ErrorBody | null;
  reload(): void;
} {
  const { catalog } = useApp();
  const [data, setData] = useState<Described | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    catalog
      .describe(table)
      .then((a) => {
        if (!live) return;
        if (a.ok) setData(a.json as unknown as Described);
        else setError(errorBodyOf(a.json));
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [catalog, table, round]);
  return { data, error, reload: () => setRound((n) => n + 1) };
}

/** Lines of a text area as a list (empty lines dropped). */
export function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A labelled text input. */
export function TextField(props: { label: string; value: string; onInput(v: string): void; help?: string; mono?: boolean }): JSX.Element {
  return (
    <label class="ui-field">
      <span>{props.label}</span>
      <input
        type="text"
        class={props.mono ? "ui-mono" : undefined}
        autocomplete="off"
        spellcheck={false}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      {props.help ? <span class="ui-field-help">{props.help}</span> : null}
    </label>
  );
}

/** A labelled text area. */
export function TextArea(props: { label: string; value: string; onInput(v: string): void; help?: string; rows?: number }): JSX.Element {
  return (
    <label class="ui-field">
      <span>{props.label}</span>
      <textarea rows={props.rows ?? 3} value={props.value} onInput={(e) => props.onInput(e.currentTarget.value)} />
      {props.help ? <span class="ui-field-help">{props.help}</span> : null}
    </label>
  );
}

/** A title and its content, folded until opened. */
export function Section(props: { title: string; open?: boolean; children: ComponentChildren }): JSX.Element {
  return (
    <details class="schema-section" open={props.open}>
      <summary>{props.title}</summary>
      <div class="schema-section-body">{props.children}</div>
    </details>
  );
}
