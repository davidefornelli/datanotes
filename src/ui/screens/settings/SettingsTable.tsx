import type { JSX } from "preact";
import { Badge, Button } from "../../components";
import { displayValue } from "../../lib/format";
import { GROUPS, groupOf, type Draft, type SettingView } from "../../lib/settings-form";
import { SettingInput } from "./SettingInput";

export interface SettingsTableProps {
  settings: SettingView[];
  draft: Draft;
  /** The engine's refusals by setting name. */
  refused: Record<string, string>;
  disabled: boolean;
  /** Changes when the inputs must show the loaded values again (discard, save, reload). */
  resetKey: number;
  onValue(view: SettingView, value: unknown): void;
  onRaw(name: string, value: unknown): void;
}

/** Every setting, one section per group: its input, default, badges and the engine's refusal. */
export function SettingsTable(props: SettingsTableProps): JSX.Element {
  return (
    <div class="settings-table">
      {GROUPS.map((group) => {
        const views = props.settings.filter((v) => groupOf(v.name) === group);
        if (views.length === 0) return null;
        return (
          <section key={group}>
            <h2>{group}</h2>
            <table>
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Value</th>
                  <th>Default</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {views.map((v) => (
                  <Row key={`${v.name}-${props.resetKey}`} view={v} {...props} />
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

function Row(props: SettingsTableProps & { view: SettingView }): JSX.Element {
  const v = props.view;
  const edited = Object.prototype.hasOwnProperty.call(props.draft, v.name);
  const refusal = props.refused[v.name];
  return (
    <tr class={edited ? "settings-row-edited" : ""}>
      <th scope="row">
        <code>{v.name}</code>
        <div class="settings-badges">
          {v.applies === "live" ? <Badge kind="ok">at once</Badge> : <Badge kind="info">after a restart</Badge>}
          {v.changed ? <Badge kind="info">changed</Badge> : null}
          {v.restart_pending ? <Badge kind="warn">restart pending</Badge> : null}
          {v.overridden_by ? <Badge kind="warn">overridden by {v.overridden_by}</Badge> : null}
          {edited ? <Badge kind="warn">edited</Badge> : null}
        </div>
        <p class="settings-help">takes {v.expected}</p>
      </th>
      <td>
        {v.editable ? (
          <SettingInput key={props.draft[v.name] === null ? "default" : "value"} view={v} draft={props.draft} disabled={props.disabled} onValue={props.onValue} onRaw={props.onRaw} />
        ) : (
          <div class="settings-input">
            <code>{displayValue(v.value)}</code>
            {v.change_with ? <p class="settings-help">{v.change_with}</p> : null}
          </div>
        )}
        {refusal ? <p class="settings-field-error">{refusal}</p> : null}
      </td>
      <td>{v.write_only ? null : <code class="settings-default">{JSON.stringify(v.default_value)}</code>}</td>
      <td>
        {v.editable && v.changed && !v.write_only ? (
          <Button disabled={props.disabled} title="Put the default value back" onClick={() => props.onValue(v, null)}>
            Default
          </Button>
        ) : null}
      </td>
    </tr>
  );
}
