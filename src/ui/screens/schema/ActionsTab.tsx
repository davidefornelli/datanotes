// The table-wide operations: alter_table (rename, move, layout, archive, packs), clone_table and
// drop_table (the table's name typed before Apply).

import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { OperationForm } from "../../components";
import type { ApiAnswer } from "../../lib/api";
import { navigate } from "../../lib/router";
import { splitQualified } from "../../lib/view-query";
import { useApp } from "../../state";
import { DdlRunner, Section, TextField, type Described } from "./shared";

/** alter_table's fields shown elsewhere (the Overview tab, Rename or move). */
const ALTER_HIDDEN = ["catalog", "schema", "name", "description", "aliases", "history", "autolink_target", "row_template", "instructions", "tags", "clear_tags", "fields"];

/** The table's name after an alter_table that may rename or move it. */
export function renamedTo(table: string, args: Record<string, unknown>): string {
  const p = splitQualified(table);
  const pick = (k: string, now: string) => (typeof args[k] === "string" && args[k] !== "" ? (args[k] as string) : now);
  return [pick("catalog", p.catalog), pick("schema", p.schema), pick("name", p.name)].filter(Boolean).join(".");
}

export function ActionsTab(props: { data: Described; onApplied(answer: ApiAnswer): void }): JSX.Element {
  const { readOnly, catalog } = useApp();
  const table = props.data.qualified;
  const parts = splitQualified(table);
  const [mode, setMode] = useState<"" | "archive">("");
  const [where, setWhere] = useState({ catalog: parts.catalog, schema: parts.schema, name: parts.name });
  if (readOnly) return <p class="ui-muted">Read only while you view as a token.</p>;
  const moveArgs: Record<string, unknown> = { table };
  if (where.catalog.trim() && where.catalog.trim() !== parts.catalog) moveArgs.catalog = where.catalog.trim();
  if (where.schema.trim() && where.schema.trim() !== parts.schema) moveArgs.schema = where.schema.trim();
  if (where.name.trim() && where.name.trim() !== parts.name) moveArgs.name = where.name.trim();
  const moved = Object.keys(moveArgs).length > 1;
  return (
    <div class="schema-actions">
      <Section title="Rename or move (alter_table)" open>
        <p class="ui-muted">Rows, archive and history follow; links to the rows are updated.</p>
        <TextField label="Catalog" value={where.catalog} onInput={(v) => setWhere({ ...where, catalog: v })} mono />
        <TextField label="Schema" value={where.schema} onInput={(v) => setWhere({ ...where, schema: v })} mono />
        <TextField label="Name" value={where.name} onInput={(v) => setWhere({ ...where, name: v })} mono />
        <DdlRunner
          op="alter_table"
          args={moved ? moveArgs : null}
          onApplied={() => navigate("table", { table: renamedTo(table, moveArgs) }, { tab: "actions" }, true)}
        />
      </Section>
      <Section title="Layout: partition, file names, archive, packs (alter_table)">
        <OperationForm op="alter_table" fixed={{ table }} hide={ALTER_HIDDEN} onDone={(a) => afterLayout(a)} />
      </Section>
      <Section title="Clone the table (clone_table)">
        <OperationForm op="clone_table" fixed={{ source: table }} onDone={(a) => afterLayout(a, false)} />
      </Section>
      <Section title="Drop the table (drop_table)">
        <p>
          A table with rows is dropped only with <code>mode: archive</code>: its rows move to its archive folder. Undo, or
          restore_table, brings it back.
        </p>
        <label class="ui-field">
          <span>mode</span>
          <select value={mode} onChange={(e) => setMode(e.currentTarget.value as "" | "archive")}>
            <option value="">(none: only an empty table)</option>
            <option value="archive">archive</option>
          </select>
        </label>
        <DdlRunner
          op="drop_table"
          args={mode ? { table, mode } : { table }}
          requireText={props.data.name}
          confirmMessage={<p>Drop the table {table}?</p>}
          applyLabel="Drop"
          onApplied={() => navigate("home", {}, {}, true)}
        />
      </Section>
    </div>
  );

  function afterLayout(a: ApiAnswer, reload = true): void {
    if (!a.ok || (a.json as { dry_run?: unknown }).dry_run === true) return;
    void catalog.refresh().catch(() => undefined);
    if (reload) props.onApplied(a);
  }
}
