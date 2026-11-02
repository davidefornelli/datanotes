import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";

/**
 * A read-only value with a Copy button. navigator.clipboard exists only in a secure context
 * (HTTPS or localhost): elsewhere (plain http on a tailnet) the text is selected and the user copies it.
 */
export function CopyField(props: { value: string; secret?: boolean }): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(!props.secret);
  const [note, setNote] = useState("");
  const select = () => {
    input.current?.focus();
    input.current?.select();
  };
  const copy = async () => {
    const clip = window.isSecureContext ? navigator.clipboard : undefined;
    if (clip) {
      try {
        await clip.writeText(props.value);
        setNote("Copied");
        return;
      } catch {
        // fall through: select it
      }
    }
    setShown(true);
    setTimeout(select, 0);
    setNote("Press Ctrl+C (Cmd+C)");
  };
  return (
    <span class="ui-copy">
      <input ref={input} type={shown ? "text" : "password"} readOnly value={props.value} autocomplete="off" spellcheck={false} onFocus={select} />
      {props.secret ? (
        <button type="button" onClick={() => setShown(!shown)}>
          {shown ? "Hide" : "Show"}
        </button>
      ) : null}
      <button type="button" onClick={() => void copy()}>
        Copy
      </button>
      {note ? <span class="ui-copy-note">{note}</span> : null}
    </span>
  );
}
