import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorBox, errorBodyOf, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { displayValue, formatTime } from "../../lib/format";
import type { Route } from "../../lib/router";
import { useApp } from "../../state";
import { useLoad } from "./use-load";

interface Extension {
  name: string;
  version: string;
  description: string;
  source: { kind: string; url?: string; path?: string; ref?: string };
  commit: string;
  token: string;
  tables: Record<string, { table: string; owned: boolean }>;
  tools: string[];
  installed_at: string;
  updated_at: string;
}

const when = (v: unknown) => (typeof v === "string" ? formatTime(v) : "");

export function ExtensionsScreen(_props: { route: Route }): JSX.Element {
  const { api, toast, isOwner, readOnly } = useApp();
  const { data, error, reload } = useLoad<{ extensions: Extension[] }>(() => api.route<{ extensions: Extension[] }>("/extensions/"), [api]);
  const [forgetting, setForgetting] = useState<Extension | null>(null);
  const [forgetError, setForgetError] = useState<ErrorBody | null>(null);
  const canWrite = isOwner && !readOnly;

  if (error) return <ErrorBox body={error} />;
  if (!data) return <Spinner />;

  const forget = async (x: Extension) => {
    setForgetting(null);
    try {
      const a = await api.route("/extensions/delete/", { name: x.name });
      if (!a.ok) setForgetError(errorBodyOf(a.json));
      else {
        setForgetError(null);
        toast({ text: `Record of ${x.name} forgotten` });
      }
    } catch (e) {
      setForgetError(errorBodyOf(e));
    }
    reload();
  };

  return (
    <div class="admin-screen">
      <h1>Extensions</h1>
      <ErrorBox body={forgetError} />
      {data.extensions.length === 0 ? (
        <EmptyState title="No extensions are installed." />
      ) : (
        <DataTable
          rows={data.extensions as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.name)}
          columns={[
            { key: "name", label: "Name" },
            { key: "version", label: "Version" },
            { key: "description", label: "Description" },
            {
              key: "source",
              label: "Source",
              render: (r) => {
                const s = r.source as Extension["source"];
                return `${s.kind}: ${s.url ?? s.path ?? ""}${s.ref ? ` @ ${s.ref}` : ""}`;
              },
            },
            { key: "commit", label: "Commit", render: (r) => <code>{String(r.commit).slice(0, 12)}</code> },
            { key: "token", label: "Token" },
            {
              key: "tables",
              label: "Table roles",
              render: (r) =>
                Object.entries(r.tables as Extension["tables"])
                  .map(([role, t]) => `${role} → ${t.table}${t.owned ? " (owned)" : ""}`)
                  .join(", "),
            },
            { key: "tools", label: "Tools", render: (r) => displayValue(r.tools) },
            { key: "installed_at", label: "Installed", render: (r) => when(r.installed_at) },
            { key: "updated_at", label: "Updated", render: (r) => when(r.updated_at) },
            ...(canWrite
              ? [
                  {
                    key: "actions",
                    label: "",
                    render: (r: Record<string, unknown>) => (
                      <Button kind="danger" onClick={() => setForgetting(r as unknown as Extension)}>
                        Forget the record…
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {forgetting ? (
        <ConfirmDialog
          title={`Forget ${forgetting.name}?`}
          confirmLabel="Forget the record"
          danger
          message={<p>This forgets the record only. To uninstall, run datanotes extension remove {forgetting.name}.</p>}
          onCancel={() => setForgetting(null)}
          onConfirm={() => void forget(forgetting)}
        />
      ) : null}
    </div>
  );
}
