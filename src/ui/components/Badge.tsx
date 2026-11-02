import type { ComponentChildren, JSX } from "preact";

export function Badge(props: { kind?: "ok" | "warn" | "error" | "info"; children: ComponentChildren; title?: string }): JSX.Element {
  return (
    <span class={`ui-badge ui-badge-${props.kind ?? "info"}`} title={props.title}>
      {props.children}
    </span>
  );
}
