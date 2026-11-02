import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

export interface ModalProps {
  title: string;
  onClose(): void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A dialog: Escape closes it, Tab stays inside it, focus goes back where it was when it closes. */
export function Modal(props: ModalProps): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // the first field or button of the body, else of the footer (Cancel comes before the confirm
    // button), else the close button: a field is ready to type in, and Enter never confirms by accident
    const inside = (part: string) => box.current?.querySelector(part)?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    const first = inside(".ui-modal-body") ?? inside(".ui-modal-foot") ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    (first ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const head = items[0]!;
      const tail = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, []);

  return (
    <div class="ui-modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class={props.wide ? "ui-modal ui-modal-wide" : "ui-modal"} role="dialog" aria-modal="true" aria-label={props.title} ref={box} tabIndex={-1}>
        <div class="ui-modal-head">
          <h2>{props.title}</h2>
          <button type="button" class="ui-modal-close" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="ui-modal-body">{props.children}</div>
        {props.footer ? <div class="ui-modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}
