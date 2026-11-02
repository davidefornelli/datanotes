// A new table: where it goes, its name and description, its columns (the engine adds `id`) and its
// options; Check shows what the engine would refuse (missing descriptions included), Create makes it.

import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, JsonEditor } from "../../components";
import type { CatalogTree } from "../../lib/catalog";
import { cleanSpec } from "../../lib/column-spec";
import { navigate, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { ColumnSpecEditor } from "./ColumnSpecEditor";
import { useTableNames } from "./ColumnsTab";
import { DdlRunner, linesOf, Section, TextArea, TextField } from "./shared";

/** Catalog and schema: a select of the tree's, or a new name. */
export function PlacePicker(props: {
  tree: CatalogTree | null;
  catalog: string;
  schema: string;
  onChange(catalog: string, schema: string): void;
}): JSX.Element {
  const catalogs = (props.tree?.catalogs ?? []).map((c) => c.catalog);
  const schemas = (props.tree?.catalogs.find((c) => c.catalog === props.catalog)?.schemas ?? []).map((s) => s.schema);
  return (
    <div class="schema-place">
      <TextField
        label="Catalog"
        value={props.catalog}
        onInput={(v) => props.onChange(v, props.schema)}
        mono
        help={catalogs.length ? `Existing: ${catalogs.join(", ")}; empty: the default.` : "Empty: the default."}
      />
      <TextField
        label="Schema"
        value={props.schema}
        onInput={(v) => props.onChange(props.catalog, v)}
        mono
        help={schemas.length ? `Existing: ${schemas.join(", ")}; empty: the default.` : "Empty: the default."}
      />
    </div>
  );
}

/** The catalog tree, loaded once. */
export function useTree(): CatalogTree | null {
  const { catalog } = useApp();
  const [tree, setTree] = useState<CatalogTree | null>(null);
  useEffect(() => {
    let live = true;
    catalog
      .load()
      .then((t) => live && setTree(t))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [catalog]);
  return tree;
}

interface ColumnDraft {
  key: number;
  spec: Record<string, unknown>;
  problems: string[];
}

export function NewTableScreen(props: { route: Route }): JSX.Element {
  const { readOnly } = useApp();
  const tree = useTree();
  const tables = useTableNames();
  const [place, setPlace] = useState({ catalog: props.route.query.catalog ?? "", schema: props.route.query.schema ?? "" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [columns, setColumns] = useState<ColumnDraft[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [opts, setOpts] = useState({ time_column: "", filename: "", partition: "", pack: "", pack_after_days: "", history: "", aliases: "", row_template: "", instructions: "" });
  const [tags, setTags] = useState<unknown>(undefined);
  const [tagsError, setTagsError] = useState<string | null>(null);

  if (readOnly) return <p class="ui-muted">Read only while you view as a token.</p>;

  const args: Record<string, unknown> = { name: name.trim(), columns: columns.map((c) => cleanSpec(c.spec)) };
  if (description.trim()) args.description = description.trim();
  if (place.catalog.trim()) args.catalog = place.catalog.trim();
  if (place.schema.trim()) args.schema = place.schema.trim();
  for (const k of ["time_column", "filename", "partition", "pack", "row_template", "instructions"] as const) if (opts[k].trim()) args[k] = opts[k];
  if (opts.pack_after_days.trim()) args.pack_after_days = Number(opts.pack_after_days);
  if (opts.history) args.history = opts.history === "true";
  if (linesOf(opts.aliases).length) args.aliases = linesOf(opts.aliases);
  if (tags !== undefined) args.tags = tags;
  const problems = [
    ...(name.trim() ? [] : ["Name the table."]),
    ...columns.flatMap((c, i) => c.problems.map((p) => `Column ${i + 1}: ${p}`)),
    ...(tagsError ? [tagsError] : []),
  ];
  const setOpt = (k: keyof typeof opts) => (v: string) => setOpts({ ...opts, [k]: v });
  const created = () => {
    const full = [args.catalog ?? tree?.config.default_catalog, args.schema ?? tree?.config.default_schema, args.name].filter(Boolean).join(".");
    navigate("table", { table: full }, {}, true);
  };

  return (
    <div class="schema-new">
      <h1>New table</h1>
      <PlacePicker tree={tree} catalog={place.catalog} schema={place.schema} onChange={(catalog, schema) => setPlace({ catalog, schema })} />
      <TextField label="Name (lowercase letters, digits, _)" value={name} onInput={setName} mono />
      <TextArea label="Description: what a row of the table records" value={description} onInput={setDescription} />
      <h2>Columns</h2>
      <p class="ui-muted">The engine adds the id column.</p>
      {columns.map((c, i) => (
        <div key={c.key} class="schema-new-column">
          <div class="schema-prop-head">
            <span class="schema-prop-label">Column {i + 1}</span>
            <Button kind="danger" onClick={() => setColumns(columns.filter((x) => x.key !== c.key))}>
              Remove
            </Button>
          </div>
          <ColumnSpecEditor
            tables={tables}
            onChange={(spec, p) => setColumns((list) => list.map((x) => (x.key === c.key ? { ...x, spec, problems: p } : x)))}
          />
        </div>
      ))}
      <p>
        <Button
          onClick={() => {
            setColumns([...columns, { key: nextKey, spec: {}, problems: [] }]);
            setNextKey(nextKey + 1);
          }}
        >
          Add a column
        </Button>
      </p>
      <Section title="More options">
        <TextField label="time_column: the date column that names the rows" value={opts.time_column} onInput={setOpt("time_column")} mono />
        <TextField label='filename: file name pattern, e.g. "{name}"' value={opts.filename} onInput={setOpt("filename")} mono />
        <TextField label='partition: sub-folder pattern, e.g. "{occurred_at:YYYY/MM}"' value={opts.partition} onInput={setOpt("partition")} mono />
        <TextField label='pack: packs of rows, e.g. "{occurred_at:YYYY-MM}"' value={opts.pack} onInput={setOpt("pack")} mono />
        <TextField label="pack_after_days" value={opts.pack_after_days} onInput={setOpt("pack_after_days")} />
        <label class="ui-field">
          <span>history</span>
          <select value={opts.history} onChange={(e) => setOpt("history")(e.currentTarget.value)}>
            <option value="">default</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </label>
        <TextArea label="Aliases, one per line" value={opts.aliases} onInput={setOpt("aliases")} />
        <JsonEditor
          label='Tags, e.g. {"domain": "health"}'
          rows={3}
          value={tags}
          onChange={(v, err) => {
            setTags(v);
            setTagsError(err);
          }}
        />
        <TextArea label="Row template (Markdown)" value={opts.row_template} onInput={setOpt("row_template")} rows={4} />
        <TextArea label="Instructions for agents (Markdown)" value={opts.instructions} onInput={setOpt("instructions")} rows={4} />
      </Section>
      <DdlRunner op="create_table" args={args} problems={problems} applyLabel="Create" onApplied={created} />
    </div>
  );
}
