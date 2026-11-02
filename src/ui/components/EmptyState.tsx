import type { ComponentChildren, JSX } from "preact";

export function EmptyState(props: { title: string; children?: ComponentChildren }): JSX.Element {
  return (
    <div class="ui-empty">
      <p class="ui-empty-title">{props.title}</p>
      {props.children ? <div class="ui-empty-body">{props.children}</div> : null}
    </div>
  );
}
