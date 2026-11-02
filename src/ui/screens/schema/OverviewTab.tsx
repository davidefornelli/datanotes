// A table's definition at a glance, each part with its own edit: description, aliases, tags, bases,
// history, automatic links, instructions, row template, fields; and the descriptions it lacks.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Badge, Button, JsonEditor } from "../../components";
import type { ApiAnswer } from "../../lib/api";
import { displayValue } from "../../lib/format";
import { useApp } from "../../state";
import { DdlRunner, linesOf, TextArea, TextField, type Described } from "./shared";

interface TabProps {
  data: Described;
  onApplied(answer: ApiAnswer): void;
}

/** A value with an Edit button that opens its form. */
function Editable(props: { label: string; value: ComponentChildren; children: ComponentChildren }): JSX.Element {
  const { readOnly } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div class="schema-prop">
      <div class="schema-prop-head">
        <span class="schema-prop-label">{props.label}</span>
        {readOnly ? null : (
          <Button onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</Button>
        )}
      </div>
      <div class="schema-prop-value">{props.value}</div>
      {open ? <div class="schema-prop-form">{props.children}</div> : null}
    </div>
  );
}

function Facts(props: { value?: Record<string, unknown> }): JSX.Element {
  const entries = Object.entries(props.value ?? {});
  if (!entries.length) return <span class="ui-muted">none</span>;
  return (
    <dl class="schema-facts">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{displayValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

const choice = (v: unknown) => (v === undefined || v === null ? "default" : String(v));
const asChoice = (s: string): boolean | "default" => (s === "true" ? true : s === "false" ? false : "default");

function TriState(props: { value: string; onChange(v: string): void }): JSX.Element {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
      <option value="default">default</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  );
}

function MissingPanel(props: TabProps): JSX.Element | null {
  const m = props.data.missing_descriptions;
  const [texts, setTexts] = useState<Record<string, string>>({});
  if (!m || (!m.table && m.columns.length === 0)) return null;
  const table = props.data.qualified;
  const item = (key: string, label: string, op: string, args: (d: string) => Record<string, unknown>) => {
    const text = texts[key] ?? "";
    return (
      <div key={key} class="schema-missing-item">
        <TextField label={label} value={text} onInput={(v) => setTexts({ ...texts, [key]: v })} />
        <DdlRunner op={op} args={text.trim() ? args(text.trim()) : null} onApplied={props.onApplied} />
      </div>
    );
  };
  return (
    <div class="schema-warning" role="note">
      <p>
        <Badge kind="warn">missing descriptions</Badge> Agents and people understand the schema through them: write what each holds.
      </p>
      {m.table ? item("", "The table: what a row records", "alter_table", (d) => ({ table, description: d })) : null}
      {m.columns.map((c) => item(`col:${c}`, `Column ${c}: what it holds`, "alter_column", (d) => ({ table, column: c, changes: { description: d } })))}
    </div>
  );
}

export function OverviewTab(props: TabProps): JSX.Element {
  const { data, onApplied } = props;
  const table = data.qualified;
  const [description, setDescription] = useState(data.description ?? "");
  const [aliases, setAliases] = useState((data.aliases ?? []).join("\n"));
  const [tagText, setTagText] = useState("");
  const [removeTags, setRemoveTags] = useState<string[]>([]);
  const [clearTags, setClearTags] = useState(false);
  const [bases, setBases] = useState((data.bases ?? []).join("\n"));
  const [history, setHistory] = useState(choice(data.history));
  const [autolink, setAutolink] = useState(choice(data.autolink_target));
  const [instructions, setInstructions] = useState(data.instructions ?? "");
  const [template, setTemplate] = useState(data.row_template ?? "");
  const [fields, setFields] = useState<unknown>(data.fields ?? {});
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [baseNames, setBaseNames] = useState<string[]>([]);
  const { catalog } = useApp();

  useEffect(() => {
    let live = true;
    catalog
      .load()
      .then((t) => live && setBaseNames(t.bases.map((b) => b.name)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [catalog]);

  const tagSet: Record<string, string | null> = {};
  const tagProblems: string[] = [];
  for (const line of linesOf(tagText)) {
    const eq = line.indexOf("=");
    if (eq <= 0) tagProblems.push(`"${line}": write key=value.`);
    else tagSet[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  for (const k of removeTags) tagSet[k] = null;
  const tagArgs: Record<string, unknown> = { table };
  if (Object.keys(tagSet).length) tagArgs.tags = tagSet;
  if (clearTags) tagArgs.clear_tags = true;

  return (
    <div class="schema-overview">
      <MissingPanel data={data} onApplied={onApplied} />
      <Editable label="Description" value={data.description ?? <span class="ui-muted">none</span>}>
        <TextArea label="What a row of the table records" value={description} onInput={setDescription} />
        <DdlRunner op="alter_table" args={{ table, description }} onApplied={onApplied} />
      </Editable>
      <Editable label="Aliases" value={(data.aliases ?? []).length ? (data.aliases ?? []).join(", ") : <span class="ui-muted">none</span>}>
        <TextArea label="Other words for what the table records, one per line" value={aliases} onInput={setAliases} />
        <DdlRunner op="alter_table" args={{ table, aliases: linesOf(aliases) }} onApplied={onApplied} />
      </Editable>
      <Editable label="Tags" value={<Facts value={data.tags} />}>
        <TextArea label="Tags to add or change, one key=value per line" value={tagText} onInput={setTagText} />
        {Object.keys(data.tags ?? {}).length ? (
          <div class="schema-checks">
            {Object.keys(data.tags ?? {}).map((k) => (
              <label key={k} class="schema-flag">
                <input
                  type="checkbox"
                  checked={removeTags.includes(k)}
                  onChange={(e) => setRemoveTags(e.currentTarget.checked ? [...removeTags, k] : removeTags.filter((x) => x !== k))}
                />{" "}
                remove <code>{k}</code>
              </label>
            ))}
            <label class="schema-flag">
              <input type="checkbox" checked={clearTags} onChange={(e) => setClearTags(e.currentTarget.checked)} /> clear all first
            </label>
          </div>
        ) : null}
        <DdlRunner op="alter_table" args={tagArgs.tags || clearTags ? tagArgs : null} problems={tagProblems} onApplied={onApplied} />
      </Editable>
      <div class="schema-prop">
        <span class="schema-prop-label">Layout</span>
        <Facts value={data.layout} />
      </div>
      <div class="schema-prop">
        <span class="schema-prop-label">Options</span>
        <Facts value={data.options} />
        <p class="ui-muted">Change them in the Actions tab.</p>
      </div>
      <div class="schema-prop">
        <span class="schema-prop-label">Rows</span>
        <span>{data.row_count ?? 0}</span>
      </div>
      <Editable label="Bases" value={(data.bases ?? []).length ? (data.bases ?? []).join(", ") : <span class="ui-muted">none</span>}>
        <TextArea
          label="The bases the table inherits from, in order, one per line"
          value={bases}
          onInput={setBases}
          help={baseNames.length ? `Bases: ${baseNames.join(", ")}.` : "The database has no bases."}
        />
        <DdlRunner op="set_table_bases" args={{ table, bases: linesOf(bases) }} onApplied={onApplied} />
      </Editable>
      <Editable label="History (versions)" value={choice(data.history)}>
        <TriState value={history} onChange={setHistory} />
        <DdlRunner op="alter_table" args={{ table, history: asChoice(history) }} onApplied={onApplied} />
      </Editable>
      <Editable label="Automatic links may link its rows" value={choice(data.autolink_target)}>
        <TriState value={autolink} onChange={setAutolink} />
        <DdlRunner op="alter_table" args={{ table, autolink_target: asChoice(autolink) }} onApplied={onApplied} />
      </Editable>
      <Editable label="Instructions" value={data.instructions ? <pre class="schema-pre">{data.instructions}</pre> : <span class="ui-muted">none</span>}>
        <TextArea label='How to fill a row, for agents (Markdown; "" removes them)' rows={6} value={instructions} onInput={setInstructions} />
        <DdlRunner op="alter_table" args={{ table, instructions }} onApplied={onApplied} />
      </Editable>
      <Editable label="Row template" value={data.row_template ? <pre class="schema-pre">{data.row_template}</pre> : <span class="ui-muted">none</span>}>
        <TextArea label='Markdown body of new rows, {column} placeholders ("" removes it)' rows={6} value={template} onInput={setTemplate} />
        <DdlRunner op="alter_table" args={{ table, row_template: template }} onApplied={onApplied} />
      </Editable>
      <Editable label="Fields (untyped)" value={<Facts value={data.fields} />}>
        <JsonEditor
          label="Fields to set, name → default; null removes one"
          value={fields}
          onChange={(v, err) => {
            setFields(v);
            setFieldsError(err);
          }}
        />
        <DdlRunner
          op="alter_table"
          args={fields && typeof fields === "object" && !Array.isArray(fields) ? { table, fields } : null}
          problems={fieldsError ? [fieldsError] : []}
          onApplied={onApplied}
        />
      </Editable>
      {(data.untyped_fields ?? []).length ? (
        <div class="schema-prop">
          <span class="schema-prop-label">Front matter keys without a column</span>
          <span>{(data.untyped_fields ?? []).join(", ")}</span>
        </div>
      ) : null}
    </div>
  );
}
