import type { ComponentChildren, JSX } from "preact";

export interface DataColumn {
  key: string;
  label: string;
  render?(row: Record<string, unknown>): ComponentChildren;
  width?: number;
}

export interface DataTableProps {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  rowKey(row: Record<string, unknown>): string;
  onRowClick?(row: Record<string, unknown>): void;
  selectable?: boolean;
  selected?: Set<string>;
  onSelect?(keys: Set<string>): void;
  sort?: { key: string; desc: boolean };
  onSort?(key: string): void;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function DataTable(props: DataTableProps): JSX.Element {
  const selected = props.selected ?? new Set<string>();
  const keys = props.rows.map(props.rowKey);
  const all = keys.length > 0 && keys.every((k) => selected.has(k));
  const toggle = (k: string) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    props.onSelect?.(next);
  };
  return (
    <div class="ui-table-wrap">
      <table class="ui-table">
        <thead>
          <tr>
            {props.selectable ? (
              <th class="ui-table-check">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={all}
                  onChange={() => props.onSelect?.(all ? new Set() : new Set(keys))}
                />
              </th>
            ) : null}
            {props.columns.map((c) => {
              const sorted = props.sort?.key === c.key;
              return (
                <th key={c.key} style={c.width ? { width: `${c.width}px` } : undefined} aria-sort={sorted ? (props.sort!.desc ? "descending" : "ascending") : undefined}>
                  {props.onSort ? (
                    <button type="button" class="ui-table-sort" onClick={() => props.onSort!(c.key)}>
                      {c.label}
                      {sorted ? (props.sort!.desc ? " ▼" : " ▲") : ""}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => {
            const k = keys[i]!;
            return (
              <tr key={k} class={props.onRowClick ? "ui-table-clickable" : undefined} onClick={props.onRowClick ? () => props.onRowClick!(row) : undefined}>
                {props.selectable ? (
                  <td class="ui-table-check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Select row" checked={selected.has(k)} onChange={() => toggle(k)} />
                  </td>
                ) : null}
                {props.columns.map((c) => (
                  <td key={c.key}>{c.render ? c.render(row) : cell(row[c.key])}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
