import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { basename, linkTarget } from "../../lib/format";
import { LinkPicker } from "./LinkPicker";

export interface ListEditorProps {
  items: string[];
  onChange(items: string[]): void;
  /** The items' type: "link" adds the picker. */
  itemType?: string;
  disabled?: boolean;
  table: string;
  column: string;
  row?: string;
  /** The form's values, for the link picker. */
  rowValues?: Record<string, unknown>;
}

/** A list column: its items as chips, one to add, each removable; link items with the picker. */
export function ListEditor(props: ListEditorProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const add = (text: string) => {
    const t = text.trim();
    if (!t) return;
    props.onChange([...props.items, t]);
    setDraft("");
  };
  const remove = (i: number) => props.onChange(props.items.filter((_, j) => j !== i));
  return (
    <div class="rows-list">
      <span class="ui-chips">
        {props.items.map((item, i) => {
          const target = linkTarget(item);
          return (
            <span key={`${i}-${item}`} class="ui-chip rows-list-chip" title={item}>
              {target ? basename(target) : item}
              {props.disabled ? null : (
                <button type="button" class="rows-list-remove" aria-label={`Remove ${item}`} onClick={() => remove(i)}>
                  ×
                </button>
              )}
            </span>
          );
        })}
      </span>
      {props.disabled ? null : (
        <span class="rows-list-add">
          <input
            type="text"
            autocomplete="off"
            aria-label={`Add to ${props.column}`}
            value={draft}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(draft);
              }
            }}
          />
          <button type="button" class="ui-button ui-button-plain" onClick={() => add(draft)}>
            Add
          </button>
          {props.itemType === "link" ? (
            <button type="button" class="ui-button ui-button-plain" onClick={() => setPicking(true)}>
              Pick…
            </button>
          ) : null}
        </span>
      )}
      {picking ? (
        <LinkPicker
          table={props.table}
          column={props.column}
          row={props.row}
          values={props.rowValues}
          onClose={() => setPicking(false)}
          onPick={(link) => {
            setPicking(false);
            props.onChange([...props.items, link]);
          }}
        />
      ) : null}
    </div>
  );
}
