import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";

export interface JsonEditorProps {
  value: unknown;
  onChange(value: unknown, error: string | null): void;
  rows?: number;
  label?: string;
}

const show = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));

/** A text area for JSON: every edit is parsed, and an error is shown under it. */
export function JsonEditor(props: JsonEditorProps): JSX.Element {
  const [text, setText] = useState(() => show(props.value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // a new value from outside (not the one this editor just sent) replaces the text
    let current: unknown;
    try {
      current = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      current = Symbol("invalid");
    }
    if (JSON.stringify(current) !== JSON.stringify(props.value)) {
      setText(show(props.value));
      setError(null);
    }
  }, [props.value]);
  const onInput = (t: string) => {
    setText(t);
    if (t.trim() === "") {
      setError(null);
      props.onChange(undefined, null);
      return;
    }
    try {
      const v: unknown = JSON.parse(t);
      setError(null);
      props.onChange(v, null);
    } catch (e) {
      const msg = `Not valid JSON: ${(e as Error).message}`;
      setError(msg);
      props.onChange(undefined, msg);
    }
  };
  return (
    <label class="ui-field ui-json">
      {props.label ? <span>{props.label}</span> : null}
      <textarea rows={props.rows ?? 6} spellcheck={false} value={text} onInput={(e) => onInput(e.currentTarget.value)} />
      {error ? <span class="ui-field-error">{error}</span> : null}
    </label>
  );
}
