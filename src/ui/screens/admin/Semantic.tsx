import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Badge, Button, ConfirmDialog, ErrorBox, errorBodyOf, Spinner } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type { Route } from "../../lib/router";
import { href } from "../../lib/router";
import { useApp } from "../../state";
import { useLoad } from "./use-load";

interface SemanticStatus {
  enabled: boolean;
  provider?: string;
  model?: string;
  files?: number;
  passages?: number;
  pending?: number;
  running?: boolean;
  last_sync?: string;
  last_error?: string;
}

export function SemanticScreen(_props: { route: Route }): JSX.Element {
  const { api, toast, isOwner, readOnly } = useApp();
  const { data, error, reload } = useLoad<SemanticStatus>(() => api.op<SemanticStatus>("describe_semantic_index"), [api]);
  const [busy, setBusy] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [runError, setRunError] = useState<ErrorBody | null>(null);

  const turnOn = isOwner && !readOnly ? (
    <p>
      <a href={href("settings")}>Turn it on in Engine settings</a>
    </p>
  ) : null;

  if (error && !data) {
    return (
      <div class="admin-screen">
        <h1>Semantic index</h1>
        <ErrorBox body={error} />
        {turnOn}
      </div>
    );
  }
  if (!data) return <Spinner />;

  const run = async (args: Record<string, unknown>) => {
    setBusy(true);
    setRunError(null);
    try {
      const a = await api.op("sync_semantic_index", args);
      if (!a.ok) setRunError(errorBodyOf(a.json));
      else toast({ text: args.rebuild ? "Index rebuilt" : "Index synced" });
    } catch (e) {
      setRunError(errorBodyOf(e));
    } finally {
      setBusy(false);
      reload();
    }
  };

  if (!data.enabled) {
    return (
      <div class="admin-screen">
        <h1>Semantic index</h1>
        <p>Semantic search is off. search_notes finds text meanwhile.</p>
        {turnOn}
      </div>
    );
  }

  const facts: [string, string][] = [
    ["Provider", data.provider ?? "–"],
    ["Model", data.model ?? "–"],
    ["Notes indexed", String(data.files ?? 0)],
    ["Passages", String(data.passages ?? 0)],
    ["Waiting", String(data.pending ?? 0)],
    ["Last sync", data.last_sync ? relativeTime(data.last_sync) : "–"],
  ];

  return (
    <div class="admin-screen">
      <div class="admin-head">
        <h1>Semantic index</h1>
        <Badge kind={data.running ? "info" : "ok"}>{data.running ? "running" : "idle"}</Badge>
      </div>
      <dl class="admin-facts">
        {facts.map(([k, v]) => (
          <>
            <dt key={`k-${k}`}>{k}</dt>
            <dd key={`v-${k}`}>{v}</dd>
          </>
        ))}
      </dl>
      {data.last_error ? <ErrorBox title="Last error" body={{ error: data.last_error }} /> : null}
      <ErrorBox body={runError} />
      <div class="admin-actions">
        <Button kind="primary" disabled={busy || readOnly} onClick={() => void run({})}>
          Sync
        </Button>
        <Button kind="danger" disabled={busy || readOnly} onClick={() => setRebuilding(true)}>
          Rebuild
        </Button>
        <Button onClick={reload}>Refresh</Button>
      </div>
      {rebuilding ? (
        <ConfirmDialog
          title="Rebuild the index?"
          confirmLabel="Rebuild"
          danger
          message={<p>Re-embeds every note: slow, and it costs money with a paid provider.</p>}
          onCancel={() => setRebuilding(false)}
          onConfirm={() => {
            setRebuilding(false);
            void run({ rebuild: true });
          }}
        />
      ) : null}
    </div>
  );
}
