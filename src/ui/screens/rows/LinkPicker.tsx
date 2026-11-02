import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, EmptyState, ErrorBox, Modal, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { useApp } from "../../state";
import { bodyOf } from "./common";

export interface LinkPickerProps {
  table: string;
  column: string;
  /** The row being edited (its valid targets may depend on it); absent for a new row. */
  row?: string;
  /** The form's values (a new row's, or the changes to `row`): a target level may depend on them. */
  values?: Record<string, unknown>;
  onPick(link: string): void;
  onClose(): void;
}

/** list_link_targets takes at most 500; the filter runs on them here. */
const LIMIT = 500;

interface Target {
  name: string;
  link: string;
  path: string;
}

/** The rows a link column may point at (list_link_targets), filtered here by what the user types. */
export function LinkPicker(props: LinkPickerProps): JSX.Element {
  const { api } = useApp();
  const [typed, setTyped] = useState("");
  const [all, setAll] = useState<Target[] | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ErrorBody | null>(null);
  // read once when the picker opens: the form's values as they are then
  const [values] = useState(props.values);

  useEffect(() => {
    let live = true;
    const args: Record<string, unknown> = { table: props.table, column: props.column, limit: LIMIT };
    if (props.row) args.row = props.row;
    if (values && Object.keys(values).length > 0) args.values = values;
    api
      .op<{ rows?: Target[]; reason?: string; total?: number }>("list_link_targets", args)
      .then((a) => {
        if (!live) return;
        if (!a.ok) {
          setError(bodyOf(a));
          setAll([]);
          return;
        }
        setError(null);
        setAll(a.json.rows ?? []);
        const more = (a.json.total ?? 0) > LIMIT ? ` (the first ${LIMIT} of ${a.json.total})` : "";
        setReason(`${a.json.reason ?? ""}${more}`);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError({ error: e instanceof Error ? e.message : String(e) });
        setAll([]);
      });
    return () => {
      live = false;
    };
  }, [api, props.table, props.column, props.row, values]);

  const needle = typed.trim().toLowerCase();
  const rows = all === null ? null : needle ? all.filter((r) => r.name.toLowerCase().includes(needle)) : all;

  return (
    <Modal title={`Pick ${props.column}`} onClose={props.onClose} footer={<Button onClick={props.onClose}>Cancel</Button>}>
      <label class="ui-field">
        <span>Filter by name</span>
        <input type="text" autocomplete="off" value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
      </label>
      {reason ? <p class="ui-muted">{reason}</p> : null}
      <ErrorBox body={error} />
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No row matches" />
      ) : (
        <ul class="rows-picker-list">
          {rows.map((r) => (
            <li key={r.path}>
              <button type="button" class="rows-picker-item" title={r.path} onClick={() => props.onPick(r.link)}>
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
