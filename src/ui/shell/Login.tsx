import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button, ErrorBox } from "../components";
import { navigate, type Route } from "../lib/router";
import { useSession } from "../state";

const REASONS: Record<string, string> = {
  refused: "The engine refused the saved token: it was rotated or deleted. Sign in again.",
  "new-token": "The engine restarted with a new owner token. Sign in with the new token.",
};

/** The sign-in page: paste a token; it is kept in this tab (or remembered) and sent only as a header. */
export function Login(props: { route: Route }): JSX.Element {
  const session = useSession();
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = REASONS[props.route.query.reason ?? ""];

  const submit = async () => {
    const t = token.trim();
    if (!t) {
      setError("Paste a token first.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await session.signIn(t, remember);
    setBusy(false);
    if (r === "ok") {
      setToken("");
      navigate("home");
    } else if (r === "refused") setError("The engine refused this token.");
    else setError(r);
  };

  return (
    <div class="shell-login">
      <form
        class="shell-login-box"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>Datanotes{session.version ? ` ${session.version}` : ""}</h1>
        <p class="ui-muted">Sign in with the owner token or a named token.</p>
        {reason && !error ? <p class="shell-login-reason">{reason}</p> : null}
        <label class="ui-field">
          <span>Token</span>
          <input
            type="password"
            autocomplete="off"
            spellcheck={false}
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            autoFocus
          />
        </label>
        <label class="shell-login-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
          <span>
            Remember on this browser
            <span class="ui-field-help">
              Anyone who uses this browser profile can then open the database. Leave it off on a shared computer.
            </span>
          </span>
        </label>
        <ErrorBox body={error ? { error } : null} />
        <Button kind="primary" type="submit" disabled={busy} onClick={() => void submit()}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
