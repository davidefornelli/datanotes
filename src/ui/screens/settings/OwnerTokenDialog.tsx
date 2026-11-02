import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button, CopyField, Modal } from "../../components";
import { newOwnerToken } from "../../lib/settings-form";

/**
 * A new owner token: generated here (crypto.getRandomValues) or typed. It lives only in this
 * dialog's state and, once used, in the draft: it is never rendered anywhere else.
 */
export function OwnerTokenDialog(props: { warning?: string; onUse(token: string): void; onCancel(): void }): JSX.Element {
  const [mode, setMode] = useState<"generate" | "type" | null>(null);
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title="Replace the owner token"
      onClose={props.onCancel}
      footer={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button kind="danger" disabled={!copied || token === ""} onClick={() => props.onUse(token)}>
            Use this token
          </Button>
        </>
      }
    >
      {props.warning ? <p class="settings-warning">{props.warning}</p> : null}
      <p>
        <Button
          onClick={() => {
            setMode("generate");
            setToken(newOwnerToken());
          }}
        >
          Generate
        </Button>{" "}
        <Button
          onClick={() => {
            setMode("type");
            setToken("");
          }}
        >
          Type my own
        </Button>
      </p>
      {mode === "generate" ? <CopyField value={token} secret /> : null}
      {mode === "type" ? (
        <label class="ui-field">
          <span>The new owner token</span>
          <input type="password" autocomplete="new-password" spellcheck={false} value={token} onInput={(e) => setToken(e.currentTarget.value)} />
        </label>
      ) : null}
      {mode ? (
        <label class="settings-check">
          <input type="checkbox" checked={copied} onChange={(e) => setCopied(e.currentTarget.checked)} /> I copied the new token and keep it somewhere safe
        </label>
      ) : null}
    </Modal>
  );
}
