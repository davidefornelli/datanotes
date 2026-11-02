import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button, ConfirmDialog, EmptyState, ErrorBox, errorBodyOf, Modal, Spinner, ValueView, WriteResult } from "../../components";
import type { ErrorBody } from "../../lib/api";
import type { WireEvent } from "../../lib/changes";
import { formatTime, undoable } from "../../lib/format";
import { buildExpect, diffRow, rawOf, readOnlyColumn, type ColumnInfo, type Raw } from "../../lib/row-form";
import { href, navigate, type Route } from "../../lib/router";
import { isWriteAnswer, type WriteAnswer } from "../../lib/write-result";
import { useApp } from "../../state";
import { bodyOf, described, type Described } from "./common";
import { DeleteDialog } from "./DeleteDialog";
import { FieldInput } from "./FieldInput";
import { BodyEditor, fieldErrors, RefusalView, refusalOf, type Refusal } from "./FormParts";
import { LinksPanel } from "./LinksPanel";

interface Loaded {
  desc: Described;
  row: Record<string, unknown>;
  body: string;
}

function rawsOf(cols: ColumnInfo[], row: Record<string, unknown>): Record<string, Raw> {
  return Object.fromEntries(cols.map((c) => [c.name, rawOf(c, row[c.name])]));
}

function actorLabel(e: WireEvent): string {
  if (e.source === "external") return "a hand edit";
  const a = e.actor ?? {};
  const who = a.harness ?? a.tool ?? "";
  if (who && a.auth) return `${who} (${a.auth})`;
  return who || a.auth || "another client";
}

async function readRow(api: ReturnType<typeof useApp>["api"], catalog: ReturnType<typeof useApp>["catalog"], table: string, path: string): Promise<Loaded | null | ErrorBody> {
  const [d, s] = await Promise.all([catalog.describe(table), api.op<{ total?: number; rows?: Record<string, unknown>[] }>("select_rows", { table, where: { path }, include_body: true, limit: 1 })]);
  if (!d.ok) return bodyOf(d);
  if (!s.ok) return bodyOf(s);
  const row = s.json.rows?.[0];
  if (!s.json.total || !row) return null;
  return { desc: described(d), row, body: typeof row.body === "string" ? row.body : "" };
}

/** #/row/<table>?path=: one row's front matter and body, edited with the engine's checks. */
export function RowScreen(props: { route: Route }): JSX.Element {
  const { api, catalog, bus, readOnly, toast } = useApp();
  const table = props.route.params.table ?? "";
  const path = props.route.query.path ?? "";

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [gone, setGone] = useState(false);
  const [loadError, setLoadError] = useState<ErrorBody | null>(null);
  const [raws, setRaws] = useState<Record<string, Raw>>({});
  const [body, setBody] = useState("");
  // D12: a person typing expects the text saved as typed; ticking the box links the notes it mentions
  const [autolink, setAutolink] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<{ r: Refusal; status: number } | null>(null);
  const [checked, setChecked] = useState<{ answer: WriteAnswer; status: number } | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState<{ by: string; at: string } | null>(null);
  const [dialog, setDialog] = useState<"delete" | "current" | "force" | "links" | null>(null);
  const [current, setCurrent] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const mine = useRef(new Set<string>());

  const reset = () => {
    setFormErrors({});
    setRefusal(null);
    setChecked(null);
    setError(null);
    setExternal(null);
  };

  useEffect(() => {
    let live = true;
    setLoadError(null);
    setGone(false);
    readRow(api, catalog, table, path)
      .then((r) => {
        if (!live) return;
        if (r === null) {
          setGone(true);
          setLoaded(null);
        } else if ("error" in r) {
          setLoadError(r as ErrorBody);
        } else {
          const l = r as Loaded;
          setLoaded(l);
          setRaws(rawsOf(l.desc.columns, l.row));
          setBody(l.body);
          reset();
        }
      })
      .catch((e: unknown) => live && setLoadError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, catalog, table, path, tick]);

  // a change to this note that is not one of this form's saves
  useEffect(
    () =>
      bus.subscribe(
        (events) => {
          const other = events.filter((e) => !(e.migration_id && mine.current.has(e.migration_id)));
          const last = other[other.length - 1];
          if (last) setExternal({ by: actorLabel(last), at: last.at });
        },
        { paths: [path] },
      ),
    [bus, path],
  );

  const reload = () => setTick((t) => t + 1);
  const cols = loaded?.desc.columns ?? [];
  const rowValues = useMemo(() => {
    if (!loaded) return {};
    return diffRow(cols, loaded.row, raws).set;
  }, [loaded, raws]);

  if (loadError) return <ErrorBox body={loadError} />;
  if (gone)
    return (
      <EmptyState title="This row no longer exists: it was deleted, archived or renamed.">
        <a href={href("rows", { object: table })}>Back to {table}</a>
      </EmptyState>
    );
  if (!loaded) return <Spinner />;

  const { desc, row } = loaded;
  const known = new Set([...cols.map((c) => c.name), ...desc.untyped, "path", "body"]);
  const others = Object.keys(row).filter((k) => !known.has(k));

  const save = async (dryRun: boolean, force = false) => {
    const d = diffRow(cols, row, raws);
    setFormErrors(d.errors);
    if (Object.keys(d.errors).length) return;
    const bodyChanged = body !== loaded.body;
    if (d.changed.length === 0 && !bodyChanged) {
      toast({ text: "Nothing to save", kind: "info" });
      return;
    }
    const args: Record<string, unknown> = { table, path, autolink, dry_run: dryRun };
    if (Object.keys(d.set).length) args.set = d.set;
    if (d.unset.length) args.unset = d.unset;
    if (bodyChanged) args.body = body;
    if (!force) {
      const expect = buildExpect(cols, row, d.changed);
      if (Object.keys(expect).length) args.expect = expect;
      if (bodyChanged) args.expect_body = loaded.body;
    }
    setBusy(true);
    setError(null);
    setChecked(null);
    try {
      const a = await api.op("update_row", args);
      if (!isWriteAnswer(a.json)) {
        setRefusal(null);
        setError(bodyOf(a));
        return;
      }
      const w = a.json;
      if (!w.ok) {
        setRefusal({ r: refusalOf(w, path), status: a.status });
        return;
      }
      setRefusal(null);
      if (dryRun) {
        setChecked({ answer: w, status: a.status });
        return;
      }
      if (w.migration_id) mine.current.add(w.migration_id);
      toast({ text: "Saved", kind: "ok", ...(w.migration_id && undoable("update_row") ? { undo: w.migration_id } : {}) });
      const moved = w.planned_moves.find((m) => m.from === path);
      if (moved) navigate("row", { table }, { path: moved.to }, true);
      else reload();
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  const showCurrent = async () => {
    const r = await readRow(api, catalog, table, path).catch(() => null);
    setCurrent(r && !("error" in r) ? (r as Loaded) : null);
    setDialog("current");
  };

  const writable = !readOnly;
  return (
    <div class="rows-screen rows-editor">
      <div class="rows-head">
        <div>
          <p class="ui-muted rows-crumb">
            <a href={href("rows", { object: table })}>{table}</a>
          </p>
          <h1 class="rows-title">{String(row.title ?? row.name ?? path.split("/").pop()?.replace(/\.md$/, "") ?? path)}</h1>
          <p class="ui-muted rows-path">{path}</p>
        </div>
        <div class="rows-actions">
          <a class="ui-button ui-button-plain" href={href("table", { table })}>Structure</a>
          <a class="ui-button ui-button-plain" href={href("table-history", { table })}>History</a>
          <Button onClick={() => setDialog("links")}>Links</Button>
          {writable ? (
            <Button kind="danger" onClick={() => setDialog("delete")}>
              Delete…
            </Button>
          ) : null}
        </div>
      </div>

      {external ? (
        <div class="rows-banner" role="status">
          Changed by {external.by} at {formatTime(external.at)}.{" "}
          <Button onClick={reload}>Reload</Button>
        </div>
      ) : null}
      {refusal?.r.rowChanged ? (
        <div class="rows-banner rows-banner-warn" role="alert">
          This row changed since you opened it.{" "}
          <Button onClick={reload}>Reload (discard my edits)</Button> <Button onClick={() => void showCurrent()}>Show current</Button>{" "}
          {writable ? (
            <Button kind="danger" onClick={() => setDialog("force")}>
              Save anyway
            </Button>
          ) : null}
        </div>
      ) : null}
      {refusal ? <RefusalView refusal={refusal.r} hints={desc.constraintHints} status={refusal.status} /> : null}
      <ErrorBox body={error} />
      {checked ? <WriteResult answer={checked.answer} status={checked.status} /> : null}

      <form class="rows-form" onSubmit={(e) => e.preventDefault()}>
        {cols.map((c) => (
          <FieldInput
            key={c.name}
            column={c}
            raw={raws[c.name] ?? rawOf(c, undefined)}
            onChange={(r) => setRaws({ ...raws, [c.name]: r })}
            errors={fieldErrors(c.name, formErrors, refusal?.r ?? null)}
            disabled={!writable || readOnlyColumn(c)}
            table={table}
            row={path}
            rowValues={rowValues}
          />
        ))}
      </form>

      {others.length ? (
        <div class="rows-others">
          <h2>Other properties</h2>
          <table class="ui-table">
            <tbody>
              {others.map((k) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>
                    <ValueView value={row[k]} fromPath={path} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2>Body</h2>
      <BodyEditor value={body} onChange={setBody} fromPath={path} disabled={!writable} />

      {writable ? (
        <div class="rows-form-buttons">
          <label class="rows-autolink">
            <input type="checkbox" checked={autolink} onChange={(e) => setAutolink(e.currentTarget.checked)} /> Link the notes this text mentions
          </label>
          <Button disabled={busy} onClick={() => void save(true)}>
            Check
          </Button>
          <Button kind="primary" disabled={busy} onClick={() => void save(false)}>
            Save
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setRaws(rawsOf(cols, row));
              setBody(loaded.body);
              reset();
            }}
          >
            Revert
          </Button>
        </div>
      ) : null}

      {dialog === "delete" ? (
        <DeleteDialog
          table={table}
          paths={[path]}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            navigate("rows", { object: table });
          }}
        />
      ) : null}
      {dialog === "force" ? (
        <ConfirmDialog
          title="Save anyway?"
          message="The row changed since you opened it. Saving now writes your values over the other change, without checking what it was."
          confirmLabel="Save anyway"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void save(false, true);
          }}
        />
      ) : null}
      {dialog === "current" ? (
        <Modal title="The row as it is now" wide onClose={() => setDialog(null)}>
          {current ? (
            <>
              <table class="ui-table">
                <tbody>
                  {Object.entries(current.row)
                    .filter(([k]) => k !== "body" && k !== "path")
                    .map(([k, v]) => (
                      <tr key={k}>
                        <th>{k}</th>
                        <td>
                          <ValueView value={v} fromPath={path} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <pre class="rows-mono rows-current-body">{current.body}</pre>
            </>
          ) : (
            <EmptyState title="This row no longer exists: it was deleted, archived or renamed." />
          )}
        </Modal>
      ) : null}
      {dialog === "links" ? (
        <Modal title="Links" wide onClose={() => setDialog(null)}>
          <LinksPanel path={path} />
        </Modal>
      ) : null}
    </div>
  );
}
