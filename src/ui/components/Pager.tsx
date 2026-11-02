import type { JSX } from "preact";

export interface PagerProps {
  total: number;
  offset: number;
  limit: number;
  onChange(offset: number, limit: number): void;
  sizes?: number[];
}

export function Pager(props: PagerProps): JSX.Element {
  const sizes = props.sizes ?? [50, 100, 250, 500, 1000];
  const from = props.total === 0 ? 0 : props.offset + 1;
  const to = Math.min(props.offset + props.limit, props.total);
  const last = Math.max(0, Math.floor((props.total - 1) / props.limit) * props.limit);
  return (
    <div class="ui-pager">
      <button type="button" disabled={props.offset === 0} onClick={() => props.onChange(0, props.limit)} aria-label="First page">
        «
      </button>
      <button type="button" disabled={props.offset === 0} onClick={() => props.onChange(Math.max(0, props.offset - props.limit), props.limit)}>
        Previous
      </button>
      <span class="ui-pager-text">
        {from}–{to} of {props.total}
      </span>
      <button type="button" disabled={to >= props.total} onClick={() => props.onChange(props.offset + props.limit, props.limit)}>
        Next
      </button>
      <button type="button" disabled={to >= props.total} onClick={() => props.onChange(last, props.limit)} aria-label="Last page">
        »
      </button>
      <label class="ui-pager-size">
        Rows per page{" "}
        <select value={String(props.limit)} onChange={(e) => props.onChange(0, Number(e.currentTarget.value))}>
          {sizes.map((s) => (
            <option key={s} value={String(s)}>
              {s}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
