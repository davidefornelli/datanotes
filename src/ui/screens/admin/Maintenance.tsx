import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Badge, Button, ConfirmDialog, ErrorBox, errorBodyOf, OperationForm, Pager, Spinner, WriteResult } from "../../components";
import type { ApiAnswer, ErrorBody } from "../../lib/api";
import { displayValue } from "../../lib/format";
import {
  argsKey,
  asRestorePreview,
  asVacuumAnswer,
  canApply,
  restoreArgs,
  restoreConfirmText,
  restoreHasWork,
  restorePreviewText,
  restoreTableLine,
  vacuumApplyArgs,
  vacuumArgs,
  vacuumConfirmText,
  vacuumDoneText,
  vacuumHasWork,
  vacuumPreviewText,
  type Previewed,
  type RestoreBy,
  type RestorePreview,
  type VacuumAnswer,
} from "../../lib/maintenance";
import type { Route } from "../../lib/router";
import { href } from "../../lib/router";
import { isWriteAnswer } from "../../lib/write-result";
import { useApp } from "../../state";

interface CheckViolation {
  column?: string;
  index?: number;
  constraint?: string;
  hint?: string;
  code: string;
  message: string;
  value?: unknown;
}

interface CheckResult {
  table: string | null;
  rows_checked: number;
  tables_checked?: number;
  total: number;
  errors?: { table: string; error: string }[];
  violations: { path: string; table?: string; violations: CheckViolation[] }[];
}

function Section(props: { title: string; help?: string; children: ComponentChildren }): JSX.Element {
  return (
    <section class="admin-section">
      <h2>{props.title}</h2>
      {props.help ? <p class="ui-muted">{props.help}</p> : null}
      {props.children}
    </section>
  );
}

function TableSelect(props: { id: string; tables: string[]; value: string; onChange(v: string): void; any?: string; disabled?: boolean }): JSX.Element {
  return (
    <div class="ui-field">
      <label for={props.id}>
        <code>table</code>
      </label>
      <select id={props.id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.value)}>
        {props.any !== undefined ? <option value="">{props.any}</option> : null}
        {props.tables.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

function violationText(v: CheckViolation): string {
  const where = v.column ?? (v.constraint ? `CHECK ${v.constraint}` : v.code);
  const value = v.value === undefined ? "" : ` (value: ${displayValue(v.value)})`;
  return `${where}: ${v.message}${value}${v.hint ? ` ${v.hint}` : ""}`;
}

function CheckRows(props: { tables: string[] }): JSX.Element {
  const { api } = useApp();
  const [table, setTable] = useState("");
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (at: number, size: number) => {
    setBusy(true);
    setError(null);
    try {
      const a = await api.op<CheckResult>("check_table", { ...(table ? { table } : {}), limit: size, offset: at });
      if (a.ok) {
        setResult(a.json);
        setOffset(at);
        setLimit(size);
      } else {
        setError(errorBodyOf(a.json));
      }
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Check rows" help="Validates every row against its table's rules.">
      <div class="admin-form">
        <TableSelect id="check-table" tables={props.tables} value={table} onChange={setTable} any="(all tables)" />
        <div class="admin-actions">
          <Button kind="primary" disabled={busy} onClick={() => void run(0, limit)}>
            Check
          </Button>
        </div>
      </div>
      <ErrorBox body={error} />
      {result ? (
        <div>
          <p>
            <Badge kind={result.total === 0 ? "ok" : "warn"}>{result.total === 0 ? "No violation" : `${result.total} rows break the rules`}</Badge> {result.rows_checked} rows checked
            {result.tables_checked !== undefined ? ` in ${result.tables_checked} tables` : ""}.
          </p>
          {(result.errors ?? []).length > 0 ? (
            <ul class="admin-list">
              {(result.errors ?? []).map((e) => (
                <li key={e.table}>
                  {e.table} could not be checked: {e.error}
                </li>
              ))}
            </ul>
          ) : null}
          {result.violations.map((row) => (
            <div key={row.path} class="admin-violations">
              <a href={href("open", {}, { path: row.path })}>{row.path}</a>
              <ul class="admin-list">
                {row.violations.map((v, i) => (
                  <li key={i}>{violationText(v)}</li>
                ))}
              </ul>
            </div>
          ))}
          {result.total > limit ? <Pager total={result.total} offset={offset} limit={limit} sizes={[50, 100, 250, 500]} onChange={(o, l) => void run(o, l)} /> : null}
        </div>
      ) : null}
    </Section>
  );
}

function TableOperation(props: { title: string; help: string; op: string; tables: string[] }): JSX.Element {
  const [table, setTable] = useState(props.tables[0] ?? "");
  return (
    <Section title={props.title} help={props.help}>
      <TableSelect id={`op-${props.op}-table`} tables={props.tables} value={table} onChange={setTable} />
      {table ? (
        <OperationForm op={props.op} fixed={{ table }} hide={["table"]} />
      ) : (
        <p class="ui-muted">There is no table yet.</p>
      )}
    </Section>
  );
}

const VIEW_AS_TEXT = "This operation writes: it is not available while you view as a token.";
const VACUUM_HELP = "Deletes transaction-log history older than a version. Preview first: Apply works only after a preview of the same table and version.";
const RESTORE_HELP = "Every table that keeps a transaction log goes back to an earlier moment. Preview first: Apply works only after a preview of the same moment.";

/** An answer that is not the one expected: the write's refusal, the engine's error, or the JSON as it came. */
function AnswerView(props: { answer: ApiAnswer }): JSX.Element {
  const { status, json } = props.answer;
  const j = json as { error?: unknown } | null;
  if (isWriteAnswer(json)) return <WriteResult answer={json} status={status} />;
  if (j !== null && typeof j.error === "string") return <ErrorBox body={errorBodyOf(json)} title={`HTTP ${status}`} />;
  return <pre class="ui-json-out">{JSON.stringify(json, null, 2)}</pre>;
}

/** Vacuum history: a preview first; Apply only for the table and version previewed (R2w3-1). */
function VacuumHistory(props: { tables: string[] }): JSX.Element {
  const { api, readOnly, toast } = useApp();
  const [table, setTable] = useState(props.tables[0] ?? "");
  const [retain, setRetain] = useState("");
  const [previewed, setPreviewed] = useState<Previewed<VacuumAnswer> | null>(null);
  const [answer, setAnswer] = useState<ApiAnswer | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const built = vacuumArgs(table, retain);
  const ready = canApply(built, previewed, vacuumHasWork);
  const clear = () => {
    setPreviewed(null);
    setAnswer(null);
    setError(null);
    setDone(null);
  };

  const preview = async () => {
    const args = built.args;
    if (args === null) return;
    clear();
    setBusy(true);
    try {
      const a = await api.op("vacuum_table", { ...args, dry_run: true });
      const p = a.ok ? asVacuumAnswer(a.json, true) : null;
      if (p) setPreviewed({ key: argsKey(args), preview: p });
      else setAnswer(a);
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setConfirming(false);
    const args = built.args;
    if (!ready || args === null || previewed === null) return;
    const body = vacuumApplyArgs(args, previewed.preview);
    clear();
    setBusy(true);
    try {
      const a = await api.op("vacuum_table", body);
      const r = a.ok ? asVacuumAnswer(a.json, false) : null;
      if (r) {
        setDone(vacuumDoneText(r));
        toast({ text: "Done", kind: "ok" });
      } else {
        setAnswer(a);
      }
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (props.tables.length === 0) {
    return (
      <Section title="Vacuum history" help={VACUUM_HELP}>
        <p class="ui-muted">There is no table yet.</p>
      </Section>
    );
  }

  return (
    <Section title="Vacuum history" help={VACUUM_HELP}>
      <div class="admin-form">
        <TableSelect
          id="vacuum-table"
          tables={props.tables}
          value={table}
          disabled={busy}
          onChange={(v) => {
            setTable(v);
            clear();
          }}
        />
        <div class="ui-field">
          <label for="vacuum-retain">
            <code>retain_from_version</code>
          </label>
          <input
            id="vacuum-retain"
            type="text"
            inputMode="numeric"
            autocomplete="off"
            spellcheck={false}
            disabled={busy}
            value={retain}
            onInput={(e) => {
              setRetain(e.currentTarget.value);
              clear();
            }}
          />
          <span class="ui-field-help">The oldest version to keep. Empty: keep only the latest version.</span>
          {built.error !== null ? <span class="ui-field-error">{built.error}</span> : null}
        </div>
        {readOnly ? (
          <p class="ui-muted">{VIEW_AS_TEXT}</p>
        ) : (
          <div class="admin-actions">
            <Button disabled={busy || built.args === null} onClick={() => void preview()}>
              Preview (dry run)
            </Button>
            <Button kind="danger" disabled={busy || !ready} onClick={() => setConfirming(true)}>
              Apply…
            </Button>
            {busy ? <Spinner label="Running…" /> : null}
          </div>
        )}
      </div>
      {previewed ? (
        <div>
          <p>{vacuumPreviewText(previewed.preview)}</p>
          {previewed.preview.deleted.length > 0 ? (
            <ul class="admin-list">
              {previewed.preview.deleted.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {answer ? <AnswerView answer={answer} /> : null}
      <ErrorBox body={error} />
      {done ? <p>{done}</p> : null}
      {confirming && previewed ? (
        <ConfirmDialog
          title="Delete old history?"
          message={vacuumConfirmText(previewed.preview)}
          confirmLabel="Delete history"
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => void apply()}
        />
      ) : null}
    </Section>
  );
}

/** Restore the database: a preview first; Apply only for the moment previewed (R2w3-1). */
function RestoreDatabase(): JSX.Element {
  const { api, readOnly, toast, catalog } = useApp();
  const [by, setBy] = useState<RestoreBy>("timestamp");
  const [text, setText] = useState("");
  const [previewed, setPreviewed] = useState<Previewed<RestorePreview> | null>(null);
  const [answer, setAnswer] = useState<ApiAnswer | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const built = restoreArgs(by, text);
  const ready = canApply(built, previewed, restoreHasWork);
  const clear = () => {
    setPreviewed(null);
    setAnswer(null);
    setError(null);
  };

  const preview = async () => {
    const args = built.args;
    if (args === null) return;
    clear();
    setBusy(true);
    try {
      const a = await api.op("restore_database", { ...args, dry_run: true });
      const p = a.ok ? asRestorePreview(a.json) : null;
      if (p) setPreviewed({ key: argsKey(args), preview: p });
      else setAnswer(a);
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setConfirming(false);
    const args = built.args;
    if (!ready || args === null) return;
    clear();
    setBusy(true);
    try {
      const a = await api.op("restore_database", { ...args, dry_run: false });
      setAnswer(a);
      const id = (a.json as { migration_id?: unknown } | null)?.migration_id;
      if (a.ok && typeof id === "string") {
        toast({ text: "Done", kind: "ok", undo: id });
        void catalog.refresh().catch(() => {});
      }
    } catch (e) {
      setError(errorBodyOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Restore the database" help={RESTORE_HELP}>
      <div class="admin-form">
        <div class="ui-field">
          <label for="restore-by">Restore to</label>
          <select
            id="restore-by"
            disabled={busy}
            value={by}
            onChange={(e) => {
              setBy(e.currentTarget.value === "before_migration" ? "before_migration" : "timestamp");
              clear();
            }}
          >
            <option value="timestamp">a time (timestamp)</option>
            <option value="before_migration">just before an operation (before_migration)</option>
          </select>
        </div>
        <div class="ui-field">
          <label for="restore-at">
            <code>{by}</code>
          </label>
          <input
            id="restore-at"
            type="text"
            autocomplete="off"
            spellcheck={false}
            disabled={busy}
            value={text}
            onInput={(e) => {
              setText(e.currentTarget.value);
              clear();
            }}
          />
          <span class="ui-field-help">
            {by === "timestamp" ? "An ISO date or date-time. Database history lists the moments." : "A migration_id or a batch id. The journal lists them."}
          </span>
          {built.error !== null && text !== "" ? <span class="ui-field-error">{built.error}</span> : null}
        </div>
        {readOnly ? (
          <p class="ui-muted">{VIEW_AS_TEXT}</p>
        ) : (
          <div class="admin-actions">
            <Button disabled={busy || built.args === null} onClick={() => void preview()}>
              Preview (dry run)
            </Button>
            <Button kind="danger" disabled={busy || !ready} onClick={() => setConfirming(true)}>
              Apply…
            </Button>
            {busy ? <Spinner label="Running…" /> : null}
          </div>
        )}
      </div>
      {previewed ? (
        <div>
          <p>{restorePreviewText(previewed.preview)}</p>
          {previewed.preview.tables.length > 0 ? (
            <ul class="admin-list">
              {previewed.preview.tables.map((t) => (
                <li key={t.table}>{restoreTableLine(t)}</li>
              ))}
            </ul>
          ) : null}
          {previewed.preview.skipped.length > 0 ? (
            <>
              <p class="ui-muted">Not restored:</p>
              <ul class="admin-list">
                {previewed.preview.skipped.map((x) => (
                  <li key={x.table}>
                    {x.table}: {x.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {answer ? <AnswerView answer={answer} /> : null}
      <ErrorBox body={error} />
      {confirming && previewed ? (
        <ConfirmDialog
          title="Restore the database?"
          message={restoreConfirmText(previewed.preview)}
          confirmLabel="Restore"
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => void apply()}
        />
      ) : null}
    </Section>
  );
}

export function MaintenanceScreen(_props: { route: Route }): JSX.Element {
  const { catalog } = useApp();
  const [tables, setTables] = useState<string[] | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);

  useEffect(() => {
    let live = true;
    catalog
      .load()
      .then((t) => live && setTables(t.catalogs.flatMap((c) => c.schemas.flatMap((s) => s.tables.map((x) => x.qualified)))))
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [catalog]);

  if (error) return <ErrorBox body={error} />;
  if (!tables) return <Spinner />;

  return (
    <div class="admin-screen">
      <h1>Maintenance</h1>
      <CheckRows tables={tables} />
      <TableOperation title="Recompute computed columns" help="Brings generated and identity values up to date." op="recompute_columns" tables={tables} />
      <TableOperation title="Align relations" help="Writes the inverse side of every link." op="align_relations" tables={tables} />
      <TableOperation title="Pack rows" help="Folds rows with the same key into one note." op="pack_rows" tables={tables} />
      <TableOperation title="Unpack rows" help="Splits packed notes back into rows." op="unpack_rows" tables={tables} />
      <VacuumHistory tables={tables} />
      <RestoreDatabase />
    </div>
  );
}
