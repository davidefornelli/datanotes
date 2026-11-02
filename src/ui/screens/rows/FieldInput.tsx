import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Badge } from "../../components";
import { displayValue } from "../../lib/format";
import { readOnlyColumn, type ColumnInfo, type Raw } from "../../lib/row-form";
import { LinkPicker } from "./LinkPicker";
import { ListEditor } from "./ListEditor";

export interface FieldInputProps {
  column: ColumnInfo;
  raw: Raw;
  onChange(raw: Raw): void;
  /** The engine's messages (and the form's own format error) for this column. */
  errors?: string[];
  disabled?: boolean;
  table: string;
  /** The row being edited; absent for a new row. */
  row?: string;
  /** The form's values, for the link picker. */
  rowValues?: Record<string, unknown>;
  /** Show the column's default as a placeholder (a new row: the engine applies it). */
  showDefault?: boolean;
}

const asText = (raw: Raw) => (typeof raw === "string" ? raw : raw === null ? "" : Array.isArray(raw) ? raw.join(", ") : String(raw));

function Control(props: FieldInputProps & { id: string }): JSX.Element {
  const c = props.column;
  const [picking, setPicking] = useState(false);
  const disabled = props.disabled || readOnlyColumn(c);
  const placeholder = props.showDefault && c.default !== undefined ? displayValue(c.default) : undefined;
  const text = asText(props.raw);
  const set = (v: string) => props.onChange(v);
  switch (c.type) {
    case "boolean":
      return (
        <select id={props.id} disabled={disabled} value={props.raw === true ? "true" : props.raw === false ? "false" : ""} onChange={(e) => {
          const v = e.currentTarget.value;
          props.onChange(v === "" ? null : v === "true");
        }}>
          <option value="">{placeholder ? `(default: ${placeholder})` : "(not set)"}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "enum": {
      const values = c.values ?? [];
      return (
        <select id={props.id} disabled={disabled} value={text} onChange={(e) => set(e.currentTarget.value)}>
          <option value="">{placeholder ? `(default: ${placeholder})` : "(not set)"}</option>
          {values.map((v) => (
            <option key={v} value={v} title={c.value_descriptions?.[v]}>
              {v}
            </option>
          ))}
          {text && !values.includes(text) ? <option value={text}>{text}</option> : null}
        </select>
      );
    }
    case "integer":
    case "number":
      return (
        <input id={props.id} type="number" disabled={disabled} placeholder={placeholder} step={c.step !== undefined ? String(c.step) : c.type === "integer" ? "1" : "any"} value={text} onInput={(e) => set(e.currentTarget.value)} />
      );
    case "date":
      return <input id={props.id} type="date" disabled={disabled} placeholder={placeholder} value={text} onInput={(e) => set(e.currentTarget.value)} />;
    case "datetime":
      return <input id={props.id} type="text" disabled={disabled} placeholder={placeholder ?? "2026-11-01T09:30"} value={text} onInput={(e) => set(e.currentTarget.value)} />;
    case "link":
      return (
        <span class="rows-link-input">
          <input id={props.id} type="text" autocomplete="off" disabled={disabled} placeholder={placeholder} value={text} onInput={(e) => set(e.currentTarget.value)} />
          {disabled ? null : (
            <button type="button" class="ui-button ui-button-plain" onClick={() => setPicking(true)}>
              Pick…
            </button>
          )}
          {picking ? (
            <LinkPicker
              table={props.table}
              column={c.name}
              row={props.row}
              values={props.rowValues}
              onClose={() => setPicking(false)}
              onPick={(link) => {
                setPicking(false);
                set(link);
              }}
            />
          ) : null}
        </span>
      );
    case "list":
      return (
        <ListEditor
          items={Array.isArray(props.raw) ? props.raw : text ? [text] : []}
          onChange={(items) => props.onChange(items)}
          itemType={c.items}
          disabled={disabled}
          table={props.table}
          column={c.name}
          row={props.row}
          rowValues={props.rowValues}
        />
      );
    case "json":
      return <textarea id={props.id} class="rows-mono" rows={Math.min(12, Math.max(3, text.split("\n").length))} spellcheck={false} disabled={disabled} value={text} onInput={(e) => set(e.currentTarget.value)} />;
    default:
      return text.includes("\n") ? (
        <textarea id={props.id} rows={Math.min(10, text.split("\n").length + 1)} disabled={disabled} placeholder={placeholder} value={text} onInput={(e) => set(e.currentTarget.value)} />
      ) : (
        <input id={props.id} type="text" disabled={disabled} placeholder={placeholder} value={text} onInput={(e) => set(e.currentTarget.value)} />
      );
  }
}

let nextId = 0;

/** One column of the row form: its label, input, help text and the engine's messages under it. */
export function FieldInput(props: FieldInputProps): JSX.Element {
  const [id] = useState(() => `rows-field-${++nextId}`);
  const c = props.column;
  const errors = props.errors ?? [];
  return (
    <div class={errors.length ? "rows-field rows-field-invalid" : "rows-field"}>
      <label class="rows-field-label" for={id}>
        <span class="rows-field-name">{c.name}</span>
        {c.required ? (
          <span class="ui-required" title="required">
            *
          </span>
        ) : null}{" "}
        <span class="ui-muted rows-field-type">{c.type === "list" && c.items ? `list of ${c.items}` : c.type}</span>
        {readOnlyColumn(c) ? <Badge kind="info">computed</Badge> : null}
      </label>
      <Control {...props} id={id} />
      {c.description ? <span class="ui-field-help">{c.description}</span> : null}
      {errors.map((e, i) => (
        <span key={i} class="ui-field-error">
          {e}
        </span>
      ))}
    </div>
  );
}
