import type { JSX } from "preact";
import { Button, CopyField, Modal } from "../../components";

/**
 * A token's value, shown once after create or rotate. The caller holds it in state only while this
 * dialog is open and forgets it on close.
 */
export function SecretDialog(props: { name: string; secret: string; onClose(): void }): JSX.Element {
  return (
    <Modal
      title={`Token ${props.name}`}
      onClose={props.onClose}
      footer={
        <Button kind="primary" onClick={props.onClose}>
          I copied it
        </Button>
      }
    >
      <p>Copy it now. The engine keeps only its hash: closing this dialog forgets it.</p>
      <CopyField value={props.secret} secret />
    </Modal>
  );
}
