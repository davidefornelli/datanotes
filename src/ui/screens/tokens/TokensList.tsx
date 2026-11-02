import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Badge, Button, ConfirmDialog, DataTable, EmptyState, ErrorBox, errorBodyOf } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { formatTime, relativeTime } from "../../lib/format";
import { href, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { patternsText, Show, useAnswer, type TokenEntry } from "./common";
import { SecretDialog } from "./SecretDialog";
import { TokenForm } from "./TokenForm";

/** A token's value after create or rotate: held here only while its dialog is open. */
interface Secret {
  name: string;
  secret: string;
}

/** Rotate and delete, each after a confirmation; a new value shows in the secret dialog. */
export function useTokenActions(onChanged: () => void): {
  rotate(name: string): void;
  remove(name: string): void;
  showSecret(s: Secret): void;
  dialogs: JSX.Element;
  error: ErrorBody | null;
} {
  const { api, toast } = useApp();
  const [rotating, setRotating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [error, setError] = useState<ErrorBody | null>(null);

  const run = async (route: string, name: string): Promise<Record<string, unknown> | null> => {
    setError(null);
    try {
      const a = await api.route(route, { name });
      if (a.ok) return a.json;
      setError(errorBodyOf(a.json));
    } catch (e) {
      setError(errorBodyOf(e));
    }
    return null;
  };
  const doRotate = async (name: string) => {
    setRotating(null);
    const json = await run("/tokens/rotate/", name);
    if (json && typeof json.token === "string") setSecret({ name, secret: json.token });
    onChanged();
  };
  const doDelete = async (name: string) => {
    setDeleting(null);
    const json = await run("/tokens/delete/", name);
    if (json) toast({ text: json.deleted ? `Token ${name} deleted` : `No token ${name}`, kind: json.deleted ? "ok" : "info" });
    onChanged();
  };

  const dialogs = (
    <>
      {rotating ? (
        <ConfirmDialog
          title={`Rotate ${rotating}`}
          message="The old value stops working at once: programs and agents using it get 401 until they get the new one."
          confirmLabel="Rotate"
          danger
          onConfirm={() => void doRotate(rotating)}
          onCancel={() => setRotating(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete ${deleting}`}
          message="The token stops working at once. The journal keeps its name on the writes it made."
          confirmLabel="Delete"
          danger
          requireText={deleting}
          onConfirm={() => void doDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
      {secret ? <SecretDialog name={secret.name} secret={secret.secret} onClose={() => setSecret(null)} /> : null}
    </>
  );
  return { rotate: setRotating, remove: setDeleting, showSecret: setSecret, dialogs, error };
}

interface Extension {
  name: string;
}

/** #/tokens: the named tokens, and the extensions' tokens marked as such. */
export function TokensScreen(_props: { route: Route }): JSX.Element {
  const { api, toast } = useApp();
  const tokens = useAnswer(() => api.route<{ tokens: TokenEntry[] }>("/tokens/"), [api]);
  const [extensions, setExtensions] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<TokenEntry | "new" | null>(null);
  const actions = useTokenActions(tokens.reload);

  useEffect(() => {
    let live = true;
    api
      .route<{ extensions?: Extension[] }>("/extensions/")
      .then((a) => live && a.ok && setExtensions(new Set((a.json.extensions ?? []).map((e) => `ext-${e.name}`))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);

  const saved = (json: Record<string, unknown>, created: boolean) => {
    setEditing(null);
    const entry = json.entry as TokenEntry | undefined;
    if (created && entry && typeof json.token === "string") actions.showSecret({ name: entry.name, secret: json.token });
    else toast({ text: `Token ${entry?.name ?? ""} saved`, kind: "ok" });
    tokens.reload();
  };

  const now = Date.now();
  return (
    <div class="tokens-screen">
      <div class="tokens-head">
        <h1>Tokens</h1>
        <Button kind="primary" onClick={() => setEditing("new")}>
          New token
        </Button>
      </div>
      <p class="ui-muted">
        Each program or agent gets its own token. See also the <a href={href("matrix")}>permission matrix</a> and <a href={href("users")}>users and sessions</a>.
      </p>
      <ErrorBox body={actions.error} />
      <Show loaded={tokens}>
        {(data) =>
          data.tokens.length === 0 ? (
            <EmptyState title="No named tokens yet">Create one for each program or agent that calls the engine.</EmptyState>
          ) : (
            <DataTable
              rows={data.tokens as unknown as Record<string, unknown>[]}
              rowKey={(r) => String(r.name)}
              columns={[
                {
                  key: "name",
                  label: "Name",
                  render: (r) => (
                    <>
                      <a href={href("token", { name: String(r.name) })}>{String(r.name)}</a>
                      {extensions.has(String(r.name)) ? (
                        <>
                          {" "}
                          <Badge kind="info">extension</Badge>
                        </>
                      ) : null}
                    </>
                  ),
                },
                { key: "description", label: "Description" },
                { key: "read", label: "Read", render: (r) => patternsText(r.read as string[]) },
                { key: "write", label: "Write", render: (r) => patternsText(r.write as string[]) },
                { key: "ddl", label: "ddl", render: (r) => (r.ddl ? "yes" : "") },
                { key: "maintain", label: "maintain", render: (r) => (r.maintain ? "yes" : "") },
                { key: "autolink", label: "autolink", render: (r) => (r.autolink === true ? "on" : r.autolink === false ? "off" : "default") },
                { key: "last_seen", label: "Last seen", render: (r) => (typeof r.last_seen === "string" ? <span title={formatTime(r.last_seen)}>{relativeTime(r.last_seen, now)}</span> : "never") },
                { key: "created_at", label: "Created", render: (r) => formatTime(String(r.created_at)) },
                {
                  key: "actions",
                  label: "",
                  render: (r) => (
                    <span class="tokens-row-actions">
                      <Button onClick={() => setEditing(r as unknown as TokenEntry)}>Edit</Button>
                      <Button onClick={() => actions.rotate(String(r.name))}>Rotate</Button>
                      <Button kind="danger" onClick={() => actions.remove(String(r.name))}>
                        Delete
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          )
        }
      </Show>
      {editing ? <TokenForm entry={editing === "new" ? null : editing} modal onSaved={saved} onCancel={() => setEditing(null)} /> : null}
      {actions.dialogs}
    </div>
  );
}
