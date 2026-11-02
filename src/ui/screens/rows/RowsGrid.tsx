import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button, DataTable, EmptyState, ErrorBox, errorBodyOf, Modal, Pager, Spinner, ValueView, WriteResult, type DataColumn } from "../../components";
import type { ErrorBody } from "../../lib/api";
import type { WireEvent } from "../../lib/changes";
import { undoable } from "../../lib/format";
import { parseValue, readOnlyColumn, type ColumnInfo, type Raw } from "../../lib/row-form";
import { href, navigate, type Route } from "../../lib/router";
import { isWriteAnswer, type WriteAnswer } from "../../lib/write-result";
import { useApp } from "../../state";
import { bodyOf, described } from "./common";
import { DeleteDialog } from "./DeleteDialog";
import { FieldInput } from "./FieldInput";
import { FilterBuilder } from "./FilterBuilder";

type Kind = "table" | "view" | "base";

interface Meta {
  kind: Kind;
  description?: string;
  /** A table's typed columns (the form's); empty for a view or a base. */
  columns: ColumnInfo[];
  /** The columns shown before any page is read: a table's and a base's; null for a view. */
  names: string[] | null;
  types: Record<string, string>;
  labels: Record<string, string>;
}

interface Page {
  total: number;
  rows: Record<string, unknown>[];
}

/** The change feed's kinds that change rows (src/core/change-feed.ts ChangeOp). */
const ROW_KINDS = ["insert", "update", "delete", "move"];

function parseWhere(text: string | undefined): { where: Record<string, unknown> | null; error: string | null } {
  if (!text) return { where: null, error: null };
  try {
    const v: unknown = JSON.parse(text);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return { where: v as Record<string, unknown>, error: null };
    return { where: null, error: "The filter in the address is not a JSON object: it is ignored." };
  } catch {
    return { where: null, error: "The filter in the address is not valid JSON: it is ignored." };
  }
}

/** #/rows/<object>: the rows of a table, a view or a base, a page at a time. */
export function RowsScreen(props: { route: Route }): JSX.Element {
  const { api, catalog, bus, readOnly } = useApp();
  const object = props.route.params.object ?? "";
  const q = props.route.query;
  const limit = Math.max(1, Number(q.limit) || 100);
  const offset = Math.max(0, Number(q.offset) || 0);
  const order = q.order ?? "";
  const picked = q.cols ? q.cols.split(",").filter(Boolean) : null;
  const { where, error: whereError } = parseWhere(q.where);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [missing, setMissing] = useState(false);
  const [metaError, setMetaError] = useState<ErrorBody | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [pageError, setPageError] = useState<ErrorBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [changes, setChanges] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<"delete" | "set" | null>(null);
  const [showFilter, setShowFilter] = useState(where !== null);
  const [seen, setSeen] = useState<string[]>([]);
  const request = useRef(0);

  const setQuery = (patch: Record<string, string>) => navigate("rows", { object }, { ...q, ...patch }, true);

  // what the object is, and its columns
  useEffect(() => {
    let live = true;
    setMeta(null);
    setMissing(false);
    setMetaError(null);
    setPage(null);
    setSelected(new Set());
    setSeen([]);
    setChanges(0);
    (async () => {
      const tree = await catalog.load();
      const kind = catalog.kindOf(object);
      if (!kind) {
        if (live) setMissing(true);
        return;
      }
      if (kind === "table") {
        const a = await catalog.describe(object);
        if (!live) return;
        if (!a.ok) {
          setMetaError(bodyOf(a));
          return;
        }
        const d = described(a);
        setMeta({
          kind,
          ...(d.description ? { description: d.description } : {}),
          columns: d.columns,
          names: d.columns.map((c) => c.name),
          types: Object.fromEntries(d.columns.map((c) => [c.name, c.type])),
          labels: {},
        });
      } else if (kind === "view") {
        const views = await catalog.views();
        if (!live) return;
        const v = views.find((x) => x.qualified === object);
        setMeta({ kind, ...(v?.description ? { description: v.description } : {}), columns: [], names: null, types: {}, labels: v?.labels ?? {} });
      } else {
        const b = tree.bases.find((x) => `base:${x.name}` === object);
        if (!live) return;
        setMeta({ kind, ...(b?.description ? { description: b.description } : {}), columns: [], names: [...(b?.columns ?? []), "_source"], types: {}, labels: {} });
      }
    })().catch((e: unknown) => live && setMetaError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [catalog, object]);

  // one page; a newer request drops the answer of an older one
  useEffect(() => {
    if (!meta) return;
    const n = ++request.current;
    setLoading(true);
    const args: Record<string, unknown> = { table: object, limit, offset };
    if (where) args.where = where;
    if (order) args.order_by = order;
    if (picked) args.columns = picked;
    api
      .op<Page>("select_rows", args)
      .then((a) => {
        if (n !== request.current) return;
        if (!a.ok) {
          setPageError(bodyOf(a));
          setPage(null);
        } else {
          setPageError(null);
          setPage({ total: a.json.total ?? 0, rows: a.json.rows ?? [] });
          const keys = new Set<string>();
          for (const r of a.json.rows ?? []) for (const k of Object.keys(r)) if (k !== "path" && k !== "body") keys.add(k);
          setSeen((before) => [...before, ...[...keys].filter((k) => !before.includes(k))]);
        }
      })
      .catch((e: unknown) => n === request.current && setPageError(errorBodyOf(e)))
      .finally(() => n === request.current && setLoading(false));
  }, [api, meta, object, q.where, order, offset, limit, q.cols, tick]);

  // changes to these rows: counted, shown as a pill until Refresh
  useEffect(() => {
    if (!meta) return;
    const count = (events: WireEvent[], info: { gap: boolean }) => {
      const n = meta.kind === "table" ? events.length : events.filter((e) => ROW_KINDS.includes(e.kind)).length;
      if (n > 0 || info.gap) setChanges((c) => c + Math.max(n, 1));
    };
    return meta.kind === "table" ? bus.subscribe(count, { tables: [object] }) : bus.subscribe(count);
  }, [bus, meta, object]);

  const all = meta?.names ?? seen;
  const shown = picked ?? (meta?.names ?? seen);
  const columns: DataColumn[] = useMemo(
    () =>
      shown.map((key) => ({
        key,
        label: meta?.labels[key] ?? key,
        render: (row: Record<string, unknown>) => (
          <span onClick={(e) => e.stopPropagation()}>
            <ValueView value={row[key]} type={meta?.types[key]} fromPath={typeof row.path === "string" ? row.path : undefined} />
          </span>
        ),
      })),
    [shown.join(","), meta],
  );

  if (missing) return <EmptyState title={`No table, view or base named ${object}`} />;
  if (metaError) return <ErrorBox body={metaError} />;
  if (!meta) return <Spinner />;

  const isTable = meta.kind === "table";
  const writable = isTable && !readOnly;
  const sort = order ? { key: order.replace(/^-/, ""), desc: order.startsWith("-") } : undefined;
  const onSort = (key: string) => {
    const next = order === key ? `-${key}` : order === `-${key}` ? "" : key;
    setQuery({ order: next, offset: "" });
  };
  const open = (row: Record<string, unknown>) => {
    const path = String(row.path ?? "");
    if (!path) return;
    if (isTable) navigate("row", { table: object }, { path });
    else navigate("open", {}, { path });
  };
  const paths = [...selected];
  const reload = () => {
    setChanges(0);
    setSelected(new Set());
    setTick((t) => t + 1);
  };

  return (
    <div class="rows-screen">
      <div class="rows-head">
        <div>
          <h1 class="rows-title">
            {object} <span class="ui-muted rows-kind">{meta.kind}</span>
          </h1>
          {meta.description ? <p class="ui-muted rows-description">{meta.description}</p> : null}
        </div>
        <div class="rows-actions">
          {meta.kind !== "base" ? <a class="ui-button ui-button-plain" href={isTable ? href("table", { table: object }) : href("view", { view: object })}>Structure</a> : null}
          {isTable ? <a class="ui-button ui-button-plain" href={href("table-history", { table: object })}>History</a> : null}
          {writable ? <a class="ui-button ui-button-primary" href={href("new-row", { table: object })}>New row</a> : null}
        </div>
      </div>

      <div class="rows-toolbar">
        <Button onClick={() => setShowFilter(!showFilter)}>{showFilter ? "Hide filter" : where ? "Filter (on)" : "Filter"}</Button>
        <details class="rows-colpicker">
          <summary class="ui-button ui-button-plain">Columns{picked ? ` (${picked.length})` : ""}</summary>
          <div class="rows-colpicker-list">
            {all.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={shown.includes(name)}
                  onChange={() => {
                    const next = shown.includes(name) ? shown.filter((x) => x !== name) : all.filter((x) => x === name || shown.includes(x));
                    setQuery({ cols: next.length === all.length ? "" : next.join(","), offset: "" });
                  }}
                />{" "}
                {meta.labels[name] ?? name}
              </label>
            ))}
            {picked ? <Button onClick={() => setQuery({ cols: "" })}>All columns</Button> : null}
          </div>
        </details>
        {writable && paths.length > 0 ? (
          <>
            <span class="ui-muted">{paths.length} selected</span>
            <Button onClick={() => setDialog("set")}>Set a column…</Button>
            <Button kind="danger" onClick={() => setDialog("delete")}>
              Delete selected…
            </Button>
          </>
        ) : null}
        {changes > 0 ? (
          <button type="button" class="rows-pill" onClick={reload}>
            {changes} {changes === 1 ? "change" : "changes"}: refresh
          </button>
        ) : null}
        {loading ? <Spinner /> : null}
      </div>

      {showFilter ? (
        <FilterBuilder
          columns={all.map((name) => ({ name, type: meta.types[name] ?? "string" }))}
          where={where}
          onApply={(w) => setQuery({ where: w ? JSON.stringify(w) : "", offset: "" })}
        />
      ) : null}
      {whereError ? <p class="ui-field-error">{whereError}</p> : null}
      <ErrorBox body={pageError} />

      {page ? (
        page.rows.length === 0 ? (
          <EmptyState title={where ? "No row matches the filter" : "No rows"} />
        ) : (
          <>
            <p class="ui-muted rows-total">
              {page.total} {page.total === 1 ? "row" : "rows"}
            </p>
            <DataTable
              columns={columns}
              rows={page.rows}
              rowKey={(r) => String(r.path ?? JSON.stringify(r))}
              onRowClick={open}
              selectable={writable}
              selected={selected}
              onSelect={setSelected}
              sort={sort}
              onSort={onSort}
            />
          </>
        )
      ) : pageError ? null : (
        <Spinner />
      )}
      {page ? <Pager total={page.total} offset={offset} limit={limit} onChange={(o, l) => setQuery({ offset: o ? String(o) : "", limit: l === 100 ? "" : String(l) })} /> : null}

      {dialog === "delete" ? (
        <DeleteDialog
          table={object}
          paths={paths}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
      {dialog === "set" ? (
        <BulkSetDialog
          table={object}
          columns={meta.columns.filter((c) => !readOnlyColumn(c))}
          paths={paths}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

interface BulkSetProps {
  table: string;
  columns: ColumnInfo[];
  paths: string[];
  onDone(): void;
  onClose(): void;
}

/** update_rows on the selected rows: one column set to one value, a dry run first. */
function BulkSetDialog(props: BulkSetProps): JSX.Element {
  const { api, toast } = useApp();
  const [name, setName] = useState(props.columns[0]?.name ?? "");
  const [raw, setRaw] = useState<Raw>("");
  const [formatError, setFormatError] = useState<string | null>(null);
  const [result, setResult] = useState<{ answer: WriteAnswer; status: number } | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const column = props.columns.find((c) => c.name === name);

  const run = async (dryRun: boolean) => {
    if (!column) return;
    const parsed = parseValue(column, raw);
    if (parsed.error) {
      setFormatError(parsed.error);
      return;
    }
    setFormatError(null);
    setBusy(true);
    setError(null);
    try {
      const change = parsed.empty ? { unset: [name] } : { set: { [name]: parsed.value } };
      const a = await api.op("update_rows", { table: props.table, where: { path: { in: props.paths } }, ...change, expect_count: props.paths.length, dry_run: dryRun });
      if (!isWriteAnswer(a.json)) {
        setResult(null);
        setError(bodyOf(a));
        return;
      }
      setResult({ answer: a.json, status: a.status });
      if (!dryRun && a.json.ok) {
        const id = a.json.migration_id;
        toast({ text: `Set ${name} on ${props.paths.length} ${props.paths.length === 1 ? "row" : "rows"}`, kind: "ok", ...(id && undoable("update_rows") ? { undo: id } : {}) });
        props.onDone();
      }
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  const checked = result?.answer.dry_run && result.answer.ok;
  return (
    <Modal
      title={`Set a column on ${props.paths.length} ${props.paths.length === 1 ? "row" : "rows"}`}
      onClose={props.onClose}
      wide
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button disabled={busy || !column} onClick={() => void run(true)}>
            Check
          </Button>
          <Button kind="primary" disabled={busy || !checked} title={checked ? undefined : "Check first"} onClick={() => void run(false)}>
            Apply
          </Button>
        </>
      }
    >
      <label class="ui-field">
        <span>Column</span>
        <select
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            const c = props.columns.find((x) => x.name === e.currentTarget.value);
            setRaw(c?.type === "list" ? [] : c?.type === "boolean" ? null : "");
            setResult(null);
          }}
        >
          {props.columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {column ? (
        <FieldInput
          key={column.name}
          column={column}
          raw={raw}
          table={props.table}
          errors={formatError ? [formatError] : []}
          onChange={(r) => {
            setRaw(r);
            setResult(null);
          }}
        />
      ) : null}
      <p class="ui-muted">An empty value removes the column from these rows.</p>
      <ErrorBox body={error} />
      {result ? <WriteResult answer={result.answer} status={result.status} /> : null}
    </Modal>
  );
}
