// A table's constraints: its CHECKs (add, drop), and what its columns require: required and unique
// columns, and the ref_where, ref_by, acyclic and hierarchy of its link columns.

import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button, EmptyState, JsonEditor, Modal } from "../../components";
import type { ApiAnswer } from "../../lib/api";
import { useApp } from "../../state";
import { DdlRunner, TextArea, TextField, type Described } from "./shared";

interface TabProps {
  data: Described;
  onApplied(answer: ApiAnswer): void;
}

function AddCheck(props: TabProps): JSX.Element {
  const [name, setName] = useState("");
  const [check, setCheck] = useState<unknown>({});
  const [checkError, setCheckError] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const isObject = check !== null && typeof check === "object" && !Array.isArray(check) && Object.keys(check as object).length > 0;
  const args: Record<string, unknown> = { table: props.data.qualified, name: name.trim(), check };
  if (hint.trim()) args.hint = hint.trim();
  return (
    <>
      <TextField label="Name" value={name} onInput={setName} mono />
      <JsonEditor
        label='The where filter every row must match, e.g. {"value": {"gte": 1}}'
        value={check}
        onChange={(v, err) => {
          setCheck(v);
          setCheckError(err);
        }}
      />
      <TextArea label="Hint: how to fix a row that breaks it (optional)" value={hint} onInput={setHint} />
      <DdlRunner
        op="add_constraint"
        args={name.trim() && isObject ? args : null}
        problems={checkError ? [checkError] : []}
        onApplied={props.onApplied}
      />
    </>
  );
}

function DropCheck(props: TabProps & { name: string }): JSX.Element {
  return (
    <DdlRunner
      op="drop_constraint"
      args={{ table: props.data.qualified, name: props.name }}
      confirmMessage={<p>Drop the CHECK {props.name}? Rows are no longer held to it.</p>}
      applyLabel="Drop"
      onApplied={props.onApplied}
    />
  );
}

export function ConstraintsTab(props: TabProps): JSX.Element {
  const { readOnly } = useApp();
  const [mode, setMode] = useState<{ kind: "add" } | { kind: "drop"; name: string } | null>(null);
  const checks = Object.entries(props.data.constraints ?? {});
  const hints = props.data.constraint_hints ?? {};
  const applied = (a: ApiAnswer) => {
    setMode(null);
    props.onApplied(a);
  };
  const required = props.data.columns.filter((c) => c.required === true).map((c) => String(c.name));
  const unique = props.data.columns.filter((c) => c.unique === true).map((c) => String(c.name));
  const links = props.data.columns.filter((c) => c.ref_where !== undefined || c.ref_by !== undefined || c.acyclic === true || c.hierarchy === true);
  return (
    <div class="schema-constraints">
      <h2>CHECK constraints</h2>
      {readOnly ? null : (
        <p>
          <Button kind="primary" onClick={() => setMode({ kind: "add" })}>
            Add a CHECK
          </Button>
        </p>
      )}
      {checks.length === 0 ? <EmptyState title="No CHECK constraints." /> : null}
      {checks.map(([name, where]) => (
        <div key={name} class="schema-check">
          <div class="schema-prop-head">
            <code class="schema-check-name">{name}</code>
            {readOnly ? null : (
              <Button kind="danger" onClick={() => setMode({ kind: "drop", name })}>
                Drop
              </Button>
            )}
          </div>
          <pre class="schema-pre">{JSON.stringify(where, null, 2)}</pre>
          {hints[name] ? <p class="ui-muted">Hint: {hints[name]}</p> : null}
        </div>
      ))}
      <h2>Columns</h2>
      <p>
        Required: {required.length ? required.join(", ") : <span class="ui-muted">none</span>}
        <br />
        Unique: {unique.length ? unique.join(", ") : <span class="ui-muted">none</span>}
      </p>
      {links.map((c) => (
        <div key={String(c.name)} class="schema-check">
          <code class="schema-check-name">{String(c.name)}</code>
          {c.hierarchy === true ? " hierarchy (one parent per row)" : ""}
          {c.acyclic === true ? " acyclic (no cycles)" : ""}
          {c.ref_where !== undefined ? (
            <>
              <p>ref_where: the linked row must match</p>
              <pre class="schema-pre">{JSON.stringify(c.ref_where, null, 2)}</pre>
            </>
          ) : null}
          {c.ref_by !== undefined ? (
            <>
              <p>ref_by: link levels</p>
              <pre class="schema-pre">{JSON.stringify(c.ref_by, null, 2)}</pre>
            </>
          ) : null}
        </div>
      ))}
      {mode ? (
        <Modal title={mode.kind === "add" ? "Add a CHECK" : `Drop CHECK ${mode.name}`} onClose={() => setMode(null)} wide={mode.kind === "add"}>
          {mode.kind === "add" ? <AddCheck data={props.data} onApplied={applied} /> : <DropCheck data={props.data} name={mode.name} onApplied={applied} />}
        </Modal>
      ) : null}
    </div>
  );
}
