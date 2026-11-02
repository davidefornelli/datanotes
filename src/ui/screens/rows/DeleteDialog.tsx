import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button, ErrorBox, Modal, WriteResult } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { undoable } from "../../lib/format";
import { isWriteAnswer, type WriteAnswer } from "../../lib/write-result";
import { useApp } from "../../state";
import { bodyOf } from "./common";

export interface DeleteDialogProps {
  table: string;
  /** The rows to delete, by path. */
  paths: string[];
  onDone(): void;
  onClose(): void;
}

/** delete_rows on some rows of a table: mode and references chosen, a dry run first, then Apply. */
export function DeleteDialog(props: DeleteDialogProps): JSX.Element {
  const { api, toast } = useApp();
  const [mode, setMode] = useState<"archive" | "delete">("archive");
  const [onReferenced, setOnReferenced] = useState<"restrict" | "set_null" | "ignore">("restrict");
  const [result, setResult] = useState<{ answer: WriteAnswer; status: number } | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const n = props.paths.length;

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const where = n === 1 ? { path: props.paths[0] } : { path: { in: props.paths } };
      const a = await api.op("delete_rows", { table: props.table, where, mode, on_referenced: onReferenced, dry_run: dryRun });
      if (!isWriteAnswer(a.json)) {
        setResult(null);
        setError(bodyOf(a));
        return;
      }
      setResult({ answer: a.json, status: a.status });
      if (!dryRun && a.json.ok) {
        const id = a.json.migration_id;
        toast({ text: `${mode === "archive" ? "Archived" : "Deleted"} ${n} ${n === 1 ? "row" : "rows"}`, kind: "ok", ...(id && undoable("delete_rows") ? { undo: id } : {}) });
        props.onDone();
      }
    } catch (e) {
      setError({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const checked = result?.answer.dry_run && result.answer.ok;
  return (
    <Modal
      title={n === 1 ? "Delete this row" : `Delete ${n} rows`}
      onClose={props.onClose}
      wide
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void run(true)}>
            Check
          </Button>
          <Button kind="danger" disabled={busy || !checked} title={checked ? undefined : "Check first"} onClick={() => void run(false)}>
            Apply
          </Button>
        </>
      }
    >
      <div class="rows-dialog-options">
        <label class="ui-field">
          <span>Mode</span>
          <select value={mode} onChange={(e) => { setMode(e.currentTarget.value as "archive" | "delete"); setResult(null); }}>
            <option value="archive">archive (move to the table's archive folder)</option>
            <option value="delete">delete (remove the files)</option>
          </select>
        </label>
        <label class="ui-field">
          <span>When other rows link to them</span>
          <select value={onReferenced} onChange={(e) => { setOnReferenced(e.currentTarget.value as "restrict" | "set_null" | "ignore"); setResult(null); }}>
            <option value="restrict">restrict (refuse)</option>
            <option value="set_null">set_null (clear those links)</option>
            <option value="ignore">ignore (leave the links)</option>
          </select>
        </label>
      </div>
      <ErrorBox body={error} />
      {result ? <WriteResult answer={result.answer} status={result.status} /> : <p class="ui-muted">Check shows what would change; Apply writes it.</p>}
    </Modal>
  );
}
