import type { JSX } from "preact";

export function Spinner(props: { label?: string } = {}): JSX.Element {
  return (
    <div class="ui-spinner" role="status" aria-live="polite">
      <span class="ui-spinner-dot" aria-hidden="true" />
      <span>{props.label ?? "Loading…"}</span>
    </div>
  );
}
