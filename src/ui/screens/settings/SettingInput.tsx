import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../components";
import { inputOf, parseInput, type Draft, type SettingView } from "../../lib/settings-form";
import { HeadersEditor } from "./HeadersEditor";
import { OwnerTokenDialog } from "./OwnerTokenDialog";

export interface SettingInputProps {
  view: SettingView;
  draft: Draft;
  disabled: boolean;
  /** A parsed value of the setting (setDraft decides whether it is an edit). */
  onValue(view: SettingView, value: unknown): void;
  /** A value the setting's own editor built; undefined: no edit. */
  onRaw(name: string, value: unknown): void;
}

const URL_HELP = "Credentials in this address are hidden. Keep the text as it is to keep them; a new address needs them typed again.";

/** What the input shows: the edit when there is one (the default for null), else the current value. */
function shownOf(v: SettingView, draft: Draft): string | boolean {
  if (!Object.prototype.hasOwnProperty.call(draft, v.name)) return inputOf(v);
  const edited = draft[v.name];
  return inputOf({ ...v, value: edited === null ? v.default_value : edited });
}

/** One setting's input, by type; a parse error shows under it. */
export function SettingInput(props: SettingInputProps): JSX.Element {
  const v = props.view;
  const [raw, setRaw] = useState<string | boolean>(() => shownOf(v, props.draft));
  const [error, setError] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);

  const take = (value: string | boolean) => {
    setRaw(value);
    const parsed = parseInput(v, value);
    if (parsed.error !== undefined) {
      setError(parsed.error);
      return;
    }
    setError(null);
    props.onValue(v, parsed.value);
  };

  if (v.write_only) {
    const set = Object.prototype.hasOwnProperty.call(props.draft, v.name);
    return (
      <div class="settings-input">
        <span class="ui-muted">{set ? "a new value is ready to save" : v.changed ? "set (hidden)" : "not set"}</span>{" "}
        <Button disabled={props.disabled} onClick={() => setTokenOpen(true)}>
          Replace…
        </Button>
        {set ? (
          <Button disabled={props.disabled} onClick={() => props.onRaw(v.name, undefined)}>
            Keep the current one
          </Button>
        ) : null}
        {tokenOpen ? (
          <OwnerTokenDialog
            warning={v.warning}
            onCancel={() => setTokenOpen(false)}
            onUse={(token) => {
              setTokenOpen(false);
              props.onRaw(v.name, token);
            }}
          />
        ) : null}
      </div>
    );
  }

  if (v.type === "string_map") {
    return <HeadersEditor view={v} patch={props.draft[v.name]} disabled={props.disabled} onPatch={(patch) => props.onRaw(v.name, patch)} />;
  }

  let input: JSX.Element;
  switch (v.type) {
    case "boolean":
      input = (
        <select disabled={props.disabled} value={raw === true || raw === "true" ? "true" : "false"} onChange={(e) => take(e.currentTarget.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
      break;
    case "integer":
    case "number":
      input = (
        <input
          type="number"
          disabled={props.disabled}
          min={v.minimum}
          max={v.maximum}
          step={v.type === "number" ? "any" : undefined}
          value={String(raw)}
          onInput={(e) => take(e.currentTarget.value)}
        />
      );
      break;
    case "enum":
      input = (
        <select disabled={props.disabled} value={String(raw)} onChange={(e) => take(e.currentTarget.value)}>
          {(v.values ?? []).map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      );
      break;
    case "string_list":
      input = <textarea rows={3} disabled={props.disabled} spellcheck={false} value={String(raw)} onInput={(e) => take(e.currentTarget.value)} />;
      break;
    default:
      input = <input type="text" disabled={props.disabled} autocomplete="off" spellcheck={false} value={String(raw)} onInput={(e) => take(e.currentTarget.value)} />;
  }
  return (
    <div class="settings-input">
      {input}
      {v.type === "string" && v.redacted ? <p class="settings-help">{URL_HELP}</p> : null}
      {error ? <p class="settings-field-error">{error}</p> : null}
    </div>
  );
}
