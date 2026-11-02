// A table's columns, and every column operation: add, alter, rename, rename an enum value, drop.
// Each one is checked (dry run) before it is applied; the engine's refusals list the violating rows.

import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, DataTable, Modal } from "../../components";
import type { ApiAnswer } from "../../lib/api";
import { alterChanges, cleanSpec, specFromColumn } from "../../lib/column-spec";
import { displayValue } from "../../lib/format";
import { href } from "../../lib/router";
import { useApp } from "../../state";
import { ColumnSpecEditor } from "./ColumnSpecEditor";
import { DdlRunner, TextField, type Described } from "./shared";

interface TabProps {
  data: Described;
  onApplied(answer: ApiAnswer): void;
}

type Mode = { kind: "add" } | { kind: "edit" | "rename" | "value" | "drop"; column: Record<string, unknown> };

/** "list of link", "enum", ... */
export function typeText(c: Record<string, unknown>): string {
  return c.type === "list" ? `list of ${String(c.items ?? "string")}` : String(c.type ?? "");
}

/** The table names of the catalog tree, for the ref select. */
export function useTableNames(): string[] {
  const { catalog } = useApp();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    catalog
      .load()
      .then((t) => live && setNames(t.catalogs.flatMap((c) => c.schemas.flatMap((s) => s.tables.map((x) => x.qualified)))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [catalog]);
  return names;
}

function AddColumn(props: TabProps & { tables: string[] }): JSX.Element {
  const [spec, setSpec] = useState<Record<string, unknown>>({});
  const [problems, setProblems] = useState<string[]>([]);
  return (
    <>
      <ColumnSpecEditor
        tables={props.tables}
        onChange={(s, p) => {
          setSpec(s);
          setProblems(p);
        }}
      />
      <DdlRunner op="add_column" args={{ table: props.data.qualified, column: cleanSpec(spec) }} problems={problems} onApplied={props.onApplied} />
    </>
  );
}

function EditColumn(props: TabProps & { tables: string[]; column: Record<string, unknown> }): JSX.Element {
  const before = specFromColumn(props.column);
  const [changes, setChanges] = useState<Record<string, unknown>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const empty = Object.keys(changes).length === 0;
  return (
    <>
      <ColumnSpecEditor
        initial={before}
        tables={props.tables}
        onChange={(s, p) => {
          setChanges(alterChanges(before, s));
          setProblems(p);
        }}
      />
      <p class="schema-changes">
        Changes: <code>{empty ? "none" : JSON.stringify(changes)}</code>
      </p>
      <p class="ui-muted">To rename the column use Rename; a description changes but never goes.</p>
      <DdlRunner
        op="alter_column"
        args={empty ? null : { table: props.data.qualified, column: String(props.column.name), changes }}
        problems={problems}
        onApplied={props.onApplied}
      />
    </>
  );
}

function RenameColumn(props: TabProps & { column: Record<string, unknown> }): JSX.Element {
  const from = String(props.column.name);
  const [to, setTo] = useState(from);
  return (
    <>
      <TextField label="New name" value={to} onInput={setTo} mono />
      <p class="ui-muted">CHECKs, ref_where and ref_by follow the new name; views and note text do not.</p>
      <DdlRunner
        op="rename_column"
        args={to.trim() && to.trim() !== from ? { table: props.data.qualified, from_column: from, to_column: to.trim() } : null}
        onApplied={props.onApplied}
      />
    </>
  );
}

function RenameValue(props: TabProps & { column: Record<string, unknown> }): JSX.Element {
  const values = Array.isArray(props.column.values) ? (props.column.values as unknown[]).map(String) : [];
  const [from, setFrom] = useState(values[0] ?? "");
  const [to, setTo] = useState("");
  return (
    <>
      <label class="ui-field">
        <span>The value</span>
        <select value={from} onChange={(e) => setFrom(e.currentTarget.value)}>
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <TextField label="Its new name" value={to} onInput={setTo} />
      <DdlRunner
        op="rename_value"
        args={from && to.trim() ? { table: props.data.qualified, column: String(props.column.name), from_value: from, to_value: to.trim() } : null}
        onApplied={props.onApplied}
      />
    </>
  );
}

function DropColumn(props: TabProps & { column: Record<string, unknown> }): JSX.Element {
  const name = String(props.column.name);
  return (
    <>
      <p>
        Removes <code>{name}</code> from the schema and from every row. The values are journaled: Undo brings them back.
      </p>
      <DdlRunner
        op="drop_column"
        args={{ table: props.data.qualified, column: name }}
        requireText={name}
        confirmMessage={<p>Drop the column {name} and its values on every row?</p>}
        applyLabel="Drop"
        onApplied={props.onApplied}
      />
    </>
  );
}

const TITLES = { add: "Add a column", edit: "Edit column", rename: "Rename column", value: "Rename a value", drop: "Drop column" };

export function ColumnsTab(props: TabProps): JSX.Element {
  const { readOnly } = useApp();
  const tables = useTableNames();
  const [mode, setMode] = useState<Mode | null>(null);
  const applied = (a: ApiAnswer) => {
    setMode(null);
    props.onApplied(a);
  };
  const actions = (c: Record<string, unknown>) =>
    readOnly ? null : (
      <span class="schema-row-actions">
        <Button onClick={() => setMode({ kind: "edit", column: c })}>Edit</Button>
        <Button onClick={() => setMode({ kind: "rename", column: c })}>Rename</Button>
        {c.type === "enum" || (c.type === "list" && c.items === "enum") ? (
          <Button onClick={() => setMode({ kind: "value", column: c })}>Rename a value</Button>
        ) : null}
        <Button kind="danger" onClick={() => setMode({ kind: "drop", column: c })}>
          Drop
        </Button>
      </span>
    );
  const columns = [
    { key: "name", label: "Name", render: (c: Record<string, unknown>) => <code>{String(c.name)}</code> },
    { key: "type", label: "Type", render: typeText },
    { key: "required", label: "Required", render: (c: Record<string, unknown>) => (c.required ? "yes" : "") },
    { key: "unique", label: "Unique", render: (c: Record<string, unknown>) => (c.unique ? "yes" : "") },
    { key: "default", label: "Default", render: (c: Record<string, unknown>) => displayValue(c.default) },
    { key: "ref", label: "Links to", render: (c: Record<string, unknown>) => (typeof c.ref === "string" ? <a href={href("table", { table: c.ref })}>{c.ref}</a> : "") },
    { key: "values", label: "Values", render: (c: Record<string, unknown>) => displayValue(c.values) },
    {
      key: "computed",
      label: "Computed",
      render: (c: Record<string, unknown>) => (c.generated ? `generated: ${String(c.generated)}` : c.identity ? `identity: ${String(c.identity)}` : ""),
    },
    { key: "description", label: "Description", render: (c: Record<string, unknown>) => displayValue(c.description) },
    { key: "actions", label: "", render: actions },
  ];
  const close = () => setMode(null);
  return (
    <div class="schema-columns">
      <p>
        {props.data.columns.length} columns.{" "}
        {readOnly ? null : (
          <Button kind="primary" onClick={() => setMode({ kind: "add" })}>
            Add column
          </Button>
        )}
      </p>
      <DataTable columns={columns} rows={props.data.columns} rowKey={(c) => String(c.name)} />
      {mode ? (
        <Modal title={mode.kind === "add" ? TITLES.add : `${TITLES[mode.kind]}: ${String(mode.column.name)}`} onClose={close} wide>
          {mode.kind === "add" ? (
            <AddColumn data={props.data} tables={tables} onApplied={applied} />
          ) : mode.kind === "edit" ? (
            <EditColumn data={props.data} tables={tables} column={mode.column} onApplied={applied} />
          ) : mode.kind === "rename" ? (
            <RenameColumn data={props.data} column={mode.column} onApplied={applied} />
          ) : mode.kind === "value" ? (
            <RenameValue data={props.data} column={mode.column} onApplied={applied} />
          ) : (
            <DropColumn data={props.data} column={mode.column} onApplied={applied} />
          )}
        </Modal>
      ) : null}
    </div>
  );
}
