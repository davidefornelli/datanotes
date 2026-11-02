import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Badge, Button, ConfirmDialog, CopyField, DataTable, EmptyState, ErrorBox, errorBodyOf, Modal, OperationForm, Spinner } from "../../components";
import type { ApiAnswer, ErrorBody } from "../../lib/api";
import { displayValue, formatTime } from "../../lib/format";
import type { Route } from "../../lib/router";
import { useApp } from "../../state";
import { useLoad } from "./use-load";

interface Webhook {
  id: string;
  url: string;
  tables?: string[];
  kinds?: string[];
  columns?: string[];
  enabled: boolean;
  cursor: number;
  failures: number;
  last_error?: string;
  last_delivery?: string;
  status: "ok" | "failing" | "disabled";
}

export function WebhooksScreen(_props: { route: Route }): JSX.Element {
  const { api, toast, isOwner, readOnly } = useApp();
  const { data, error, reload } = useLoad<{ webhooks: Webhook[] }>(() => api.op<{ webhooks: Webhook[] }>("list_webhooks"), [api]);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [deleteError, setDeleteError] = useState<ErrorBody | null>(null);
  const canWrite = isOwner && !readOnly;

  if (error) return <ErrorBox body={error} />;
  if (!data) return <Spinner />;

  const remove = async (w: Webhook) => {
    setDeleting(null);
    try {
      const a = await api.op("delete_webhook", { id: w.id });
      if (!a.ok) setDeleteError(errorBodyOf(a.json));
      else {
        setDeleteError(null);
        toast({ text: `Webhook ${w.id} deleted` });
      }
    } catch (e) {
      setDeleteError(errorBodyOf(e));
    }
    reload();
  };

  const created = (a: ApiAnswer) => {
    const s = (a.json as { secret?: unknown }).secret;
    if (a.ok && typeof s === "string") {
      setCreating(false);
      setSecret(s);
    }
    if (a.ok) reload();
  };

  const kind = (s: Webhook["status"]) => (s === "ok" ? "ok" : s === "failing" ? "error" : "warn");

  return (
    <div class="admin-screen">
      <div class="admin-head">
        <h1>Webhooks</h1>
        {canWrite ? (
          <Button kind="primary" onClick={() => setCreating(true)}>
            Create webhook
          </Button>
        ) : null}
      </div>
      <ErrorBox body={deleteError} />
      {data.webhooks.length === 0 ? (
        <EmptyState title="No webhooks." />
      ) : (
        <DataTable
          rows={data.webhooks as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.id)}
          columns={[
            { key: "id", label: "Id" },
            { key: "url", label: "URL", render: (r) => <span class="admin-pre">{String(r.url)}</span> },
            { key: "tables", label: "Tables", render: (r) => displayValue(r.tables) || "all" },
            { key: "kinds", label: "Kinds", render: (r) => displayValue(r.kinds) || "all" },
            { key: "status", label: "Status", render: (r) => <Badge kind={kind(r.status as Webhook["status"])}>{String(r.status)}</Badge> },
            { key: "failures", label: "Failures" },
            { key: "last_error", label: "Last error", render: (r) => displayValue(r.last_error) },
            { key: "last_delivery", label: "Last delivery", render: (r) => (typeof r.last_delivery === "string" ? formatTime(r.last_delivery) : "") },
            { key: "cursor", label: "Cursor" },
            ...(canWrite
              ? [
                  {
                    key: "actions",
                    label: "",
                    render: (r: Record<string, unknown>) => (
                      <Button kind="danger" onClick={() => setDeleting(r as unknown as Webhook)}>
                        Delete
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {creating ? (
        <Modal title="Create webhook" wide onClose={() => setCreating(false)}>
          <OperationForm op="create_webhook" confirm="A webhook sends the database's changes to this address." submitLabel="Create" onDone={created} />
        </Modal>
      ) : null}
      {secret ? (
        <Modal
          title="Webhook secret"
          onClose={() => setSecret(null)}
          footer={<Button kind="primary" onClick={() => setSecret(null)}>Done</Button>}
        >
          <p>Give this secret to the receiver. It is shown only now.</p>
          <CopyField value={secret} secret />
        </Modal>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete webhook?"
          confirmLabel="Delete"
          danger
          message={<p>Deliveries to {deleting.url} stop. The receiver is not told.</p>}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      ) : null}
    </div>
  );
}
