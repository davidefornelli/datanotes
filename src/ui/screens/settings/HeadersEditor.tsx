import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../components";
import { headerPatch, headerRows, type HeaderEdit, type HeaderRow, type SettingView } from "../../lib/settings-form";

/**
 * The telemetryHeaders editor: the engine shows the header names only, never their values. A value
 * can be replaced or the header removed; new headers get a name and a value. The edits become a patch.
 */
export function HeadersEditor(props: { view: SettingView; patch: unknown; disabled: boolean; onPatch(patch: Record<string, string | null> | undefined): void }): JSX.Element {
  const current: Record<string, string> =
    typeof props.view.value === "object" && props.view.value !== null && !Array.isArray(props.view.value) ? (props.view.value as Record<string, string>) : {};
  // after a reload or a restart the editor mounts again: its rows come back from the draft's patch
  const [start] = useState(() => headerRows(current, props.patch));
  const [rows, setRows] = useState<HeaderRow[]>(start.rows);
  const [replacing, setReplacing] = useState<Set<string>>(() => new Set(start.replacing));
  const [errors, setErrors] = useState<string[]>([]);

  const update = (next: HeaderRow[]) => {
    setRows(next);
    const edits: HeaderEdit[] = [];
    for (const r of next) {
      if (r.existing && r.remove) edits.push({ name: r.name, remove: true });
      else if (r.existing && r.value === "") continue;
      else if (!r.existing && r.name === "" && r.value === "") continue; // a blank new row: nothing yet
      else edits.push({ name: r.name, value: r.value });
    }
    const { patch, errors: errs } = headerPatch(current, edits);
    setErrors(errs);
    props.onPatch(errs.length === 0 && Object.keys(patch).length > 0 ? patch : undefined);
  };
  const change = (i: number, part: Partial<HeaderRow>) => update(rows.map((r, j) => (j === i ? { ...r, ...part } : r)));

  return (
    <div class="settings-headers">
      {rows.length === 0 ? <p class="ui-muted">No header.</p> : null}
      {rows.map((r, i) => (
        <div class="settings-header-row" key={i}>
          {r.existing ? (
            <>
              <code class={r.remove ? "settings-removed" : ""}>{r.name}</code>
              {r.remove ? (
                <span class="ui-muted">removed on save</span>
              ) : replacing.has(r.name) ? (
                <input type="password" aria-label={`New value of ${r.name}`} autocomplete="new-password" disabled={props.disabled} value={r.value} onInput={(e) => change(i, { value: e.currentTarget.value })} />
              ) : (
                <span class="ui-muted">value hidden</span>
              )}
              {!r.remove && !replacing.has(r.name) ? (
                <Button disabled={props.disabled} onClick={() => setReplacing(new Set([...Array.from(replacing), r.name]))}>
                  Replace value
                </Button>
              ) : null}
              <Button disabled={props.disabled} onClick={() => change(i, { remove: !r.remove })}>
                {r.remove ? "Keep" : "Remove"}
              </Button>
            </>
          ) : (
            <>
              <input type="text" placeholder="Header name" aria-label="Header name" autocomplete="off" spellcheck={false} disabled={props.disabled} value={r.name} onInput={(e) => change(i, { name: e.currentTarget.value })} />
              <input type="password" placeholder="Value" aria-label="Header value" autocomplete="new-password" disabled={props.disabled} value={r.value} onInput={(e) => change(i, { value: e.currentTarget.value })} />
              <Button disabled={props.disabled} onClick={() => update(rows.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </>
          )}
        </div>
      ))}
      <Button disabled={props.disabled} onClick={() => update([...rows, { name: "", value: "", remove: false, existing: false }])}>
        Add header
      </Button>
      {errors.map((e) => (
        <p class="settings-field-error" key={e}>
          {e}
        </p>
      ))}
    </div>
  );
}
