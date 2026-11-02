import type { JSX } from "preact";
import type { ErrorBody } from "../lib/api";

/** Only the engine's documentation opens from an error. */
export function docsLink(docs: string | undefined): string | null {
  return typeof docs === "string" && docs.startsWith("https://datanotes.dev/") ? docs : null;
}

/** An error of the engine (or of the browser): what is wrong, how to fix it, where to read more. */
export function ErrorBox(props: { body: ErrorBody | null; title?: string }): JSX.Element | null {
  const b = props.body;
  if (!b) return null;
  const docs = docsLink(b.docs);
  return (
    <div class="ui-error" role="alert">
      {props.title ? <p class="ui-error-title">{props.title}</p> : null}
      <p class="ui-error-message">{b.error}</p>
      {b.hint ? <p class="ui-error-hint">{b.hint}</p> : null}
      {docs ? (
        <p class="ui-error-docs">
          <a href={docs} target="_blank" rel="noopener noreferrer">
            Read more in the docs
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** The ErrorBody of anything a call can throw or answer. */
export function errorBodyOf(e: unknown): ErrorBody {
  if (e && typeof e === "object" && "body" in e && (e as { body?: unknown }).body) return (e as { body: ErrorBody }).body;
  if (e instanceof Error) return { error: e.message };
  if (e && typeof e === "object" && typeof (e as { error?: unknown }).error === "string") {
    const j = e as ErrorBody;
    const out: ErrorBody = { error: j.error };
    if (typeof j.hint === "string") out.hint = j.hint;
    if (typeof j.docs === "string") out.docs = j.docs;
    return out;
  }
  return { error: String(e) };
}
