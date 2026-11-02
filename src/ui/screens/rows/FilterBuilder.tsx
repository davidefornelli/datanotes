import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, JsonEditor } from "../../components";
import { conditionsToWhere, OPERATORS, whereToConditions, type Condition, type Operator } from "../../lib/where";

export interface FilterBuilderProps {
  /** The columns to filter on, with their types. */
  columns: { name: string; type: string }[];
  /** The `where` applied now (null: none). */
  where: Record<string, unknown> | null;
  onApply(where: Record<string, unknown> | null): void;
}

const blank = (column = ""): Condition => ({ column, op: "eq", value: "" });

/** The grid's filter: conditions that all hold, or the whole `where` as JSON. */
export function FilterBuilder(props: FilterBuilderProps): JSX.Element {
  const fromWhere = (w: Record<string, unknown> | null) => (w ? whereToConditions(w) : []);
  const [conds, setConds] = useState<Condition[]>(() => fromWhere(props.where) ?? []);
  const [json, setJson] = useState(() => props.where !== null && fromWhere(props.where) === null);
  const [jsonValue, setJsonValue] = useState<unknown>(props.where ?? {});
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // the applied filter changed from outside (the hash): show it
  useEffect(() => {
    const c = fromWhere(props.where);
    if (c === null) setJson(true);
    else setConds(c);
    setJsonValue(props.where ?? {});
    setErrors([]);
  }, [JSON.stringify(props.where)]);

  const types = Object.fromEntries(props.columns.map((c) => [c.name, c.type]));
  const update = (i: number, patch: Partial<Condition>) => setConds(conds.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const apply = () => {
    if (json) {
      if (jsonError) return;
      const v = jsonValue;
      if (v === undefined || (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)) {
        props.onApply(null);
        return;
      }
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        setErrors(["The filter must be a JSON object, such as {\"status\": \"todo\"}"]);
        return;
      }
      setErrors([]);
      props.onApply(v as Record<string, unknown>);
      return;
    }
    const r = conditionsToWhere(conds, types);
    setErrors(r.errors);
    if (r.errors.length) return;
    props.onApply(Object.keys(r.where).length ? r.where : null);
  };

  const toggleJson = () => {
    if (!json) {
      const r = conditionsToWhere(conds, types);
      setJsonValue(r.errors.length ? props.where ?? {} : r.where);
      setJsonError(null);
      setJson(true);
      return;
    }
    const v = jsonValue;
    const c = v !== null && typeof v === "object" && !Array.isArray(v) ? whereToConditions(v as Record<string, unknown>) : null;
    if (c === null) {
      setErrors(["This filter uses and, or, not or nested values: it stays in JSON."]);
      return;
    }
    setConds(c);
    setErrors([]);
    setJson(false);
  };

  return (
    <div class="rows-filter">
      {json ? (
        <JsonEditor
          label="Filter (the where of select_rows)"
          value={jsonValue}
          rows={4}
          onChange={(v, e) => {
            setJsonValue(v);
            setJsonError(e);
          }}
        />
      ) : (
        <div class="rows-filter-rows">
          {conds.map((c, i) => (
            <div key={i} class="rows-filter-row">
              <select aria-label="Column" value={c.column} onChange={(e) => update(i, { column: e.currentTarget.value })}>
                <option value="">(column)</option>
                <option value="path">path</option>
                {props.columns.map((col) => (
                  <option key={col.name} value={col.name}>
                    {col.name}
                  </option>
                ))}
              </select>
              <select aria-label="Operator" value={c.op} onChange={(e) => update(i, { op: e.currentTarget.value as Operator })}>
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <input
                type="text"
                aria-label="Value"
                placeholder={c.op === "in" ? "a, b, c" : c.op === "exists" ? "true or false" : "value"}
                value={c.value}
                onInput={(e) => update(i, { value: e.currentTarget.value })}
                onKeyDown={(e) => e.key === "Enter" && apply()}
              />
              <button type="button" class="ui-button ui-button-plain" aria-label="Remove condition" onClick={() => setConds(conds.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" class="ui-button ui-button-plain" onClick={() => setConds([...conds, blank()])}>
            Add condition
          </button>
        </div>
      )}
      {errors.map((e, i) => (
        <p key={i} class="ui-field-error">
          {e}
        </p>
      ))}
      <div class="rows-filter-buttons">
        <Button kind="primary" disabled={json && jsonError !== null} onClick={apply}>
          Apply
        </Button>
        <Button
          onClick={() => {
            setConds([]);
            setJsonValue({});
            setErrors([]);
            props.onApply(null);
          }}
        >
          Clear
        </Button>
        <Button onClick={toggleJson}>{json ? "Conditions" : "JSON"}</Button>
      </div>
    </div>
  );
}
