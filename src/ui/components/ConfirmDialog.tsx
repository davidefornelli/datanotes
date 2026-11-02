import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "./Button";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
  title: string;
  message: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  /** The user types this text (a table name, a host) before the button works. */
  requireText?: string;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const [typed, setTyped] = useState("");
  const ready = props.requireText === undefined || typed === props.requireText;
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      footer={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button kind={props.danger ? "danger" : "primary"} disabled={!ready} onClick={props.onConfirm}>
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <div class="ui-confirm-message">{props.message}</div>
      {props.requireText !== undefined ? (
        <label class="ui-field">
          <span>
            Type <code>{props.requireText}</code> to confirm
          </span>
          <input type="text" autocomplete="off" spellcheck={false} value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
        </label>
      ) : null}
    </Modal>
  );
}
