import type { ComponentChildren, JSX } from "preact";

export interface ButtonProps {
  kind?: "primary" | "danger" | "plain";
  disabled?: boolean;
  onClick: () => void;
  children: ComponentChildren;
  title?: string;
  type?: "button" | "submit";
}

export function Button(props: ButtonProps): JSX.Element {
  return (
    <button
      type={props.type ?? "button"}
      class={`ui-button ui-button-${props.kind ?? "plain"}`}
      disabled={props.disabled}
      title={props.title}
      onClick={(e) => {
        if (props.type === "submit") e.preventDefault();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}
