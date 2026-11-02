// The editor of one column spec: the fields its type takes (attrsForType), each parsed into the
// JSON type the engine expects; the engine judges the spec (Check). "Advanced: JSON" edits it whole.

import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { JsonEditor } from "../../components";
import { COLUMN_TYPES, attrsForType, specProblems } from "../../lib/column-spec";
import { linesOf } from "./shared";

export interface ColumnSpecEditorProps {
  initial?: Record<string, unknown>;
  /** Qualified names of the tables a link may name. */
  tables: string[];
  onChange(spec: Record<string, unknown>, problems: string[]): void;
}

const SCALARS = COLUMN_TYPES.filter((t) => t !== "list");
const FLAGS = new Set(["required", "unique", "ordered", "hierarchy", "acyclic", "dense"]);
const NUMBERS = new Set(["min", "max", "step"]);
const LINES = new Set(["values", "aliases"]);
const JSONS = new Set(["value_descriptions", "ref_where", "ref_by"]);
const TEXTS = new Set(["inverse", "generated", "vocabulary", "label", "note"]);

const HELP: Record<string, string> = {
  description: "What the column holds, for people and agents (required).",
  required: "Every row must have a value.",
  unique: "No two rows share a value.",
  default: "The value of a new row without one ({today} and {now} for dates).",
  values: "One value per line.",
  value_descriptions: 'Each value\'s meaning: {"value": "meaning"}.',
  ordered: "The values are a scale (they compare by position).",
  ref: "The table the link names; empty: any note.",
  inverse: "The column of the linked table that links back.",
  hierarchy: "One parent per row: a tree.",
  acyclic: "Refuse writes that close a cycle.",
  ref_where: "A where filter the linked row must match.",
  ref_by: "Link levels: which rows may link to which (see list_link_targets).",
  generated: "An expression the engine computes the value from.",
  identity: "A value the engine sets: uuid, filename or created.",
  vocabulary: "A table whose rows are the allowed values.",
  aliases: "Other names of the column, one per line.",
  label: "A heading for the column.",
  note: "A note for the people who fill it.",
  dense: "Written on every row (with the default).",
};

function effective(spec: Record<string, unknown>): string {
  return spec.type === "list" ? String(spec.items ?? "string") : String(spec.type ?? "string");
}

/** The default as the JSON type of the column. */
function parseDefault(text: string, type: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  if (type === "number" || type === "integer") return Number.isFinite(Number(t)) ? Number(t) : text;
  if (type === "boolean") return t === "true" ? true : t === "false" ? false : text;
  if (type === "json" || t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function textOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function ColumnSpecEditor(props: ColumnSpecEditorProps): JSX.Element {
  const [spec, setSpec] = useState<Record<string, unknown>>(() => ({ type: "string", ...(props.initial ?? {}) }));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    const problems = specProblems(spec);
    props.onChange(spec, jsonError ? [...problems, jsonError] : problems);
    // onChange is the parent's: called on every edit of the spec
  }, [spec, jsonError]);

  const set = (k: string, v: unknown) => {
    const next = { ...spec };
    if (v === undefined) delete next[k];
    else next[k] = v;
    if (k === "type" || k === "items") {
      // attributes the new type does not take would be refused
      const keep = new Set([...attrsForType(String(next.type), next.items as string | undefined), "external_default"]);
      for (const key of Object.keys(next)) if (!keep.has(key)) delete next[key];
      if (next.type === "list" && next.items === undefined) next.items = "string";
    }
    setSpec(next);
  };
  const draft = (k: string, text: string, value: unknown) => {
    setDrafts({ ...drafts, [k]: text });
    set(k, value);
  };

  const type = String(spec.type ?? "string");
  const attrs = attrsForType(type, spec.items as string | undefined);
  const eff = effective(spec);

  const field = (k: string): JSX.Element | null => {
    const id = `colspec-${k}`;
    const label = (
      <label for={id}>
        <code>{k}</code>
      </label>
    );
    const help = HELP[k] ? <span class="ui-field-help">{HELP[k]}</span> : null;
    let control: JSX.Element;
    if (k === "type" || k === "items") {
      const options = k === "type" ? COLUMN_TYPES : SCALARS;
      control = (
        <select id={id} value={String(spec[k] ?? (k === "type" ? "string" : "string"))} onChange={(e) => set(k, e.currentTarget.value)}>
          {options.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      );
    } else if (FLAGS.has(k)) {
      return (
        <label class="ui-field schema-flag" key={k}>
          <span>
            <input type="checkbox" checked={spec[k] === true} onChange={(e) => set(k, e.currentTarget.checked ? true : undefined)} /> <code>{k}</code>
          </span>
          {help}
        </label>
      );
    } else if (k === "description") {
      control = <textarea id={id} rows={2} value={textOf(spec[k])} onInput={(e) => set(k, e.currentTarget.value || undefined)} />;
    } else if (NUMBERS.has(k)) {
      control = (
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autocomplete="off"
          value={drafts[k] ?? textOf(spec[k])}
          onInput={(e) => {
            const t = e.currentTarget.value;
            const n = Number(t);
            draft(k, t, t.trim() === "" ? undefined : Number.isFinite(n) ? n : t);
          }}
        />
      );
    } else if (k === "default") {
      control = (
        <input
          id={id}
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={drafts[k] ?? textOf(spec[k])}
          onInput={(e) => draft(k, e.currentTarget.value, parseDefault(e.currentTarget.value, eff))}
        />
      );
    } else if (LINES.has(k)) {
      control = (
        <textarea
          id={id}
          rows={3}
          spellcheck={false}
          value={drafts[k] ?? (Array.isArray(spec[k]) ? (spec[k] as unknown[]).map(String).join("\n") : "")}
          onInput={(e) => {
            const lines = linesOf(e.currentTarget.value);
            draft(k, e.currentTarget.value, lines.length ? lines : undefined);
          }}
        />
      );
    } else if (JSONS.has(k)) {
      return (
        <div class="ui-field" key={k}>
          {label}
          <JsonEditor value={spec[k]} rows={3} onChange={(v, err) => (err ? undefined : set(k, v))} />
          {help}
        </div>
      );
    } else if (k === "ref") {
      const current = textOf(spec.ref);
      const options = ["self", ...props.tables];
      if (current && !options.includes(current)) options.push(current);
      control = (
        <select id={id} value={current} onChange={(e) => set(k, e.currentTarget.value || undefined)}>
          <option value="">(any note)</option>
          {options.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      );
    } else if (k === "identity") {
      control = (
        <select id={id} value={textOf(spec.identity)} onChange={(e) => set(k, e.currentTarget.value || undefined)}>
          <option value="">(none)</option>
          {(eff === "string" ? ["uuid", "filename"] : ["created"]).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      );
    } else if (TEXTS.has(k) || k === "name") {
      control = (
        <input
          id={id}
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={textOf(spec[k])}
          onInput={(e) => set(k, e.currentTarget.value === "" ? undefined : e.currentTarget.value)}
        />
      );
    } else {
      return null;
    }
    return (
      <div class="ui-field" key={k}>
        {label}
        {control}
        {help}
      </div>
    );
  };

  return (
    <div class="schema-colspec">
      <div class="schema-colspec-fields">{attrs.map(field)}</div>
      <label class="schema-flag">
        <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.currentTarget.checked)} /> Advanced: JSON
      </label>
      {advanced ? (
        <JsonEditor
          value={spec}
          rows={10}
          label="The whole spec"
          onChange={(v, err) => {
            setJsonError(err);
            if (!err && v !== null && typeof v === "object" && !Array.isArray(v)) {
              setDrafts({});
              setSpec(v as Record<string, unknown>);
            } else if (!err) {
              setJsonError("The spec is a JSON object.");
            }
          }}
        />
      ) : null}
    </div>
  );
}
