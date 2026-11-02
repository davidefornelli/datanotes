// A new view: where it goes, its name (vw_ by convention), description, aliases, query and labels;
// Preview runs the query, Check asks the engine, Create saves it.

import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Badge, Button, JsonEditor } from "../../components";
import { navigate, type Route } from "../../lib/router";
import { previewArgs } from "../../lib/view-query";
import { useApp } from "../../state";
import { PlacePicker, useTree } from "./NewTable";
import { DdlRunner, linesOf, TextArea, TextField } from "./shared";
import { RowsPreview } from "./ViewScreen";

export function NewViewScreen(props: { route: Route }): JSX.Element {
  const { readOnly } = useApp();
  const tree = useTree();
  const [place, setPlace] = useState({ catalog: props.route.query.catalog ?? "", schema: props.route.query.schema ?? "" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [query, setQuery] = useState<unknown>({ table: "", columns: [], where: {} });
  const [queryError, setQueryError] = useState<string | null>(null);
  const [labels, setLabels] = useState<unknown>(undefined);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null | undefined>(undefined);

  if (readOnly) return <p class="ui-muted">Read only while you view as a token.</p>;
  const isQuery = query !== null && typeof query === "object" && !Array.isArray(query);
  const args: Record<string, unknown> = { name: name.trim(), query };
  if (place.catalog.trim()) args.catalog = place.catalog.trim();
  if (place.schema.trim()) args.schema = place.schema.trim();
  if (description.trim()) args.description = description.trim();
  if (linesOf(aliases).length) args.aliases = linesOf(aliases);
  if (labels !== undefined) args.labels = labels;
  const problems = [
    ...(name.trim() ? [] : ["Name the view."]),
    ...(isQuery ? [] : ["The query is a JSON object."]),
    ...[queryError, labelsError].filter((x): x is string => Boolean(x)),
  ];
  const created = () => {
    const full = [args.catalog ?? tree?.config.default_catalog, args.schema ?? tree?.config.default_schema, args.name].filter(Boolean).join(".");
    navigate("view", { view: String(full) }, {}, true);
  };

  return (
    <div class="schema-new">
      <h1>New view</h1>
      <PlacePicker tree={tree} catalog={place.catalog} schema={place.schema} onChange={(catalog, schema) => setPlace({ catalog, schema })} />
      <TextField label="Name" value={name} onInput={setName} mono />
      {name.trim() && !name.trim().startsWith("vw_") ? (
        <p>
          <Badge kind="warn">name</Badge> Views share names and folders with tables: start the name with vw_.
        </p>
      ) : null}
      <TextArea label="Description: what the view shows" value={description} onInput={setDescription} />
      <TextArea label="Aliases, one per line" value={aliases} onInput={setAliases} />
      <JsonEditor
        label="Query: select_rows arguments (table, columns, where, order_by, ...) or a union"
        rows={10}
        value={query}
        onChange={(v, err) => {
          setQuery(v);
          setQueryError(err);
        }}
      />
      <JsonEditor
        label="Labels: column → heading (optional)"
        rows={3}
        value={labels}
        onChange={(v, err) => {
          setLabels(v);
          setLabelsError(err);
        }}
      />
      <p>
        <Button disabled={!isQuery} onClick={() => setPreview(isQuery ? previewArgs(query as Record<string, unknown>) : null)}>
          Preview
        </Button>
      </p>
      {preview !== undefined ? <RowsPreview args={preview} none="A union query: use Check to run it." /> : null}
      <DdlRunner op="create_view" args={args} problems={problems} applyLabel="Create" onApplied={created} />
    </div>
  );
}
