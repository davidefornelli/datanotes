import type { JSX } from "preact";

export interface TabsProps {
  tabs: { id: string; label: string }[];
  active: string;
  onChange(id: string): void;
}

export function Tabs(props: TabsProps): JSX.Element {
  return (
    <div class="ui-tabs" role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === props.active}
          class={t.id === props.active ? "ui-tab ui-tab-active" : "ui-tab"}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
