import type { JSX } from "preact";
import { Button, DataTable, EmptyState, ErrorBox } from "../../components";
import { href, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { Show, useAnswer, type TokenEntry } from "./common";
import type { PermissionsAnswer } from "./Matrix";
import { TokenForm } from "./TokenForm";
import { useTokenActions } from "./TokensList";

/** #/tokens/<name>: the token's form, and what the engine lets it read and write. */
export function TokenScreen(props: { route: Route }): JSX.Element {
  const { api, toast } = useApp();
  const name = props.route.params.name ?? "";
  const tokens = useAnswer(() => api.route<{ tokens: TokenEntry[] }>("/tokens/"), [api]);
  const matrix = useAnswer(() => api.route<PermissionsAnswer>("/tokens/permissions/", { name }), [api, name]);
  const reload = () => {
    tokens.reload();
    matrix.reload();
  };
  const actions = useTokenActions(reload);

  return (
    <div class="tokens-screen">
      <p>
        <a href={href("tokens")}>Tokens</a> / <code>{name}</code>
      </p>
      <ErrorBox body={actions.error} />
      <Show loaded={tokens}>
        {(data) => {
          const entry = data.tokens.find((t) => t.name === name);
          if (!entry) return <EmptyState title={`No token ${name}`}>It may have been deleted. Its writes stay in the journal.</EmptyState>;
          return (
            <>
              <div class="tokens-head">
                <h1>{name}</h1>
                <span class="tokens-row-actions">
                  <Button onClick={() => actions.rotate(name)}>Rotate</Button>
                  <Button kind="danger" onClick={() => actions.remove(name)}>
                    Delete
                  </Button>
                </span>
              </div>
              <p>
                <a href={href("user", { name })}>Sessions and writes of {name}</a>
              </p>
              <TokenForm
                key={entry.updated_at}
                entry={entry}
                modal={false}
                onSaved={() => {
                  toast({ text: `Token ${name} saved`, kind: "ok" });
                  reload();
                }}
              />
              <h2>What it may read and write</h2>
              <Show loaded={matrix}>
                {(m) => {
                  const row = m.tokens[0];
                  if (!row) return <EmptyState title="No permissions to show" />;
                  const kinds = new Map(m.objects.map((o) => [o.name, o.kind]));
                  return (
                    <DataTable
                      rows={row.access as unknown as Record<string, unknown>[]}
                      rowKey={(r) => String(r.object)}
                      columns={[
                        { key: "object", label: "Object", render: (r) => <code>{String(r.object)}</code> },
                        { key: "kind", label: "Kind", render: (r) => kinds.get(String(r.object)) ?? "" },
                        { key: "read", label: "Read", render: (r) => (r.read ? "yes" : "—") },
                        { key: "write", label: "Write", render: (r) => (r.write ? "yes" : "—") },
                        {
                          key: "why",
                          label: "Pattern or reason",
                          render: (r) => (typeof r.reason === "string" ? r.reason : [...new Set([r.read_pattern, r.write_pattern].filter((p) => typeof p === "string"))].join(", ")),
                        },
                      ]}
                    />
                  );
                }}
              </Show>
            </>
          );
        }}
      </Show>
      {actions.dialogs}
    </div>
  );
}
