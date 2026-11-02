import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ApiAnswer, ErrorBody } from "../lib/api";
import { undoable } from "../lib/format";
import { buildArgs, fieldsOf, operationSchema, operationWrites, rawOf, type FieldSpec } from "../lib/schema-forms";
import { isWriteAnswer } from "../lib/write-result";
import { useApp } from "../state";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorBox, errorBodyOf } from "./ErrorBox";
import { Spinner } from "./Spinner";
import { WriteResult } from "./WriteResult";

export interface OperationFormProps {
  op: string;
  /** Arguments sent as given, without a field. */
  fixed?: Record<string, unknown>;
  /** Starting values of the fields. */
  initial?: Record<string, unknown>;
  /** Fields not shown (and not sent unless fixed). */
  hide?: string[];
  /** A confirmation shown before Apply / Run. */
  confirm?: string;
  submitLabel?: string;
  onDone?(answer: ApiAnswer): void;
}

type Raw = Record<string, string | boolean | null>;

function Field(props: { spec: FieldSpec; value: string; error?: string; onInput(v: string): void }): JSX.Element {
  const { spec } = props;
  const id = `op-field-${spec.name}`;
  let control: JSX.Element;
  if (spec.kind === "enum" || spec.kind === "boolean") {
    const values = spec.kind === "enum" ? spec.enumValues ?? [] : ["true", "false"];
    control = (
      <select id={id} value={props.value} onChange={(e) => props.onInput(e.currentTarget.value)}>
        <option value="">{spec.defaultValue !== undefined ? `(default: ${String(spec.defaultValue)})` : "(not set)"}</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  } else if (spec.kind === "text" || spec.kind === "json" || spec.kind === "string-list") {
    control = (
      <textarea
        id={id}
        class={spec.kind === "json" ? "ui-mono" : undefined}
        rows={spec.kind === "text" ? 4 : 3}
        spellcheck={spec.kind === "text"}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type="text"
        inputMode={spec.kind === "integer" || spec.kind === "number" ? "numeric" : undefined}
        autocomplete="off"
        spellcheck={false}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    );
  }
  const hint =
    spec.kind === "string-list" ? "One value per line." : spec.kind === "json" ? "JSON." : spec.kind === "integer" ? "A whole number." : "";
  return (
    <div class="ui-field">
      <label for={id}>
        <code>{spec.name}</code>
        {spec.required ? <span class="ui-required"> (required)</span> : null}
      </label>
      {control}
      {spec.description || hint ? <span class="ui-field-help">{[spec.description, hint].filter(Boolean).join(" ")}</span> : null}
      {props.error ? <span class="ui-field-error">{props.error}</span> : null}
    </div>
  );
}

/** A form for any operation, built from its input schema in the OpenAPI document. */
export function OperationForm(props: OperationFormProps): JSX.Element {
  const { api, toast, readOnly } = useApp();
  const [specs, setSpecs] = useState<FieldSpec[] | null>(null);
  const [hasDryRun, setHasDryRun] = useState(false);
  const [writes, setWrites] = useState(false);
  const [loadError, setLoadError] = useState<ErrorBody | null>(null);
  const [raw, setRaw] = useState<Raw>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiAnswer | null>(null);
  const [callError, setCallError] = useState<ErrorBody | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let live = true;
    setSpecs(null);
    setLoadError(null);
    setResult(null);
    api
      .openapi()
      .then((doc) => {
        if (!live) return;
        const schema = operationSchema(doc, props.op);
        if (!schema) {
          setLoadError({ error: `The engine has no operation named ${props.op}.`, hint: "The operations console lists every operation." });
          return;
        }
        const hidden = new Set([...(props.hide ?? []), ...Object.keys(props.fixed ?? {})]);
        const all = fieldsOf(schema);
        const shown = all.filter((f) => !hidden.has(f.name));
        const start: Raw = {};
        for (const f of shown) start[f.name] = rawOf(f, props.initial?.[f.name]);
        setHasDryRun(Boolean(schema.properties?.dry_run));
        setWrites(operationWrites(doc, props.op));
        setRaw(start);
        setErrors({});
        setSpecs(shown);
      })
      .catch((e: unknown) => live && setLoadError(errorBodyOf(e)));
    return () => {
      live = false;
    };
    // the form is rebuilt for a new operation; fixed, hide and initial are read once per operation
  }, [api, props.op]);

  const run = async (dryRun: boolean | null) => {
    if (!specs) return;
    const built = buildArgs(specs, raw);
    setErrors(built.errors);
    if (Object.keys(built.errors).length) return;
    const args: Record<string, unknown> = { ...(props.fixed ?? {}), ...built.args };
    if (dryRun !== null) args.dry_run = dryRun;
    setBusy(true);
    setCallError(null);
    setResult(null);
    try {
      const a = await api.op(props.op, args);
      setResult(a);
      const j = a.json as { migration_id?: unknown };
      if (a.ok && dryRun !== true && typeof j.migration_id === "string") {
        toast({ text: "Done", kind: "ok", ...(undoable(props.op) ? { undo: j.migration_id } : {}) });
      }
      props.onDone?.(a);
    } catch (e) {
      setCallError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (dryRun: boolean | null) => {
    if (props.confirm && dryRun !== true) setConfirming(true);
    else void run(dryRun);
  };

  if (loadError) return <ErrorBox body={loadError} />;
  if (!specs) return <Spinner />;
  const blocked = readOnly && writes;
  const answer = result?.json;

  return (
    <form class="ui-opform" onSubmit={(e) => e.preventDefault()}>
      {specs.length === 0 ? <p class="ui-muted">This operation takes no arguments.</p> : null}
      {specs.map((s) => (
        <Field key={s.name} spec={s} value={String(raw[s.name] ?? "")} error={errors[s.name]} onInput={(v) => setRaw({ ...raw, [s.name]: v })} />
      ))}
      {blocked ? (
        <p class="ui-muted">This operation writes: it is not available while you view as a token.</p>
      ) : (
        <div class="ui-opform-buttons">
          {hasDryRun ? (
            <>
              <Button disabled={busy} onClick={() => submit(true)}>
                Check (dry run)
              </Button>
              <Button kind="primary" disabled={busy} onClick={() => submit(false)}>
                {props.submitLabel ?? "Apply"}
              </Button>
            </>
          ) : (
            <Button kind="primary" disabled={busy} onClick={() => submit(null)}>
              {props.submitLabel ?? "Run"}
            </Button>
          )}
          {busy ? <Spinner label="Running…" /> : null}
        </div>
      )}
      <ErrorBox body={callError} />
      {result && answer !== undefined ? (
        isWriteAnswer(answer) ? (
          <WriteResult answer={answer} status={result.status} />
        ) : !result.ok && typeof (answer as { error?: unknown }).error === "string" ? (
          <ErrorBox body={errorBodyOf(answer)} title={`HTTP ${result.status}`} />
        ) : (
          <pre class="ui-json-out">{JSON.stringify(answer, null, 2)}</pre>
        )
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={`Run ${props.op}?`}
          message={props.confirm}
          confirmLabel={props.submitLabel ?? (hasDryRun ? "Apply" : "Run")}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run(hasDryRun ? false : null);
          }}
        />
      ) : null}
    </form>
  );
}
