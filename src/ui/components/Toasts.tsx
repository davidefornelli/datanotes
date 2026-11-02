import type { JSX } from "preact";
import { useApp, useToasts } from "../state";

/** The toasts of useApp().toast(); Undo calls undo_migration and says how it went. */
export function Toasts(): JSX.Element {
  const { toasts, dismiss } = useToasts();
  const { api, toast } = useApp();

  const undo = async (id: number, migration: string) => {
    dismiss(id);
    try {
      const a = await api.op<{ error?: string; hint?: string }>("undo_migration", { migration_id: migration });
      if (a.ok) toast({ text: "Undone", kind: "ok" });
      else if (a.status === 409) toast({ text: a.json.hint ?? a.json.error ?? "The engine cannot undo this write.", kind: "error" });
      else toast({ text: a.json.error ?? `Undo failed (HTTP ${a.status})`, kind: "error" });
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    }
  };

  return (
    <div class="ui-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`ui-toast ui-toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span class="ui-toast-text">{t.text}</span>
          {t.undo ? (
            <button type="button" class="ui-toast-undo" onClick={() => void undo(t.id, t.undo!)}>
              Undo
            </button>
          ) : null}
          <button type="button" class="ui-toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
