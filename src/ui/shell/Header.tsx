import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Badge } from "../components";
import { href, navigate } from "../lib/router";
import { useApp } from "../state";
import { Search } from "./Search";

/** (G5) The owner's "view as" choice: every named token, read only. */
function ViewAsSelect(): JSX.Element | null {
  const { api, viewAs, setViewAs } = useApp();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    // the token list is the owner's own: read it as the owner, not as the token being viewed
    api
      .withViewAs(null)
      .route<{ tokens?: { name: string }[] }>("/tokens/")
      .then((a) => live && a.ok && setNames((a.json.tokens ?? []).map((t) => t.name)))
      .catch(() => {});
    return () => {
      live = false;
    };
    // the list is read once per sign-in
  }, []);
  if (names.length === 0 && !viewAs) return null;
  return (
    <label class="shell-viewas-select">
      <span>View as</span>
      <select value={viewAs ?? ""} onChange={(e) => setViewAs(e.currentTarget.value || null)}>
        <option value="">Yourself (owner)</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Header(): JSX.Element {
  const { api, identity, isOwner, signOut } = useApp();
  const [title, setTitle] = useState(isOwner ? "Signed in with the owner token" : "");
  useEffect(() => {
    if (isOwner) return;
    let live = true;
    api
      .route<{ entry?: Record<string, unknown> | null }>("/tokens/me/")
      .then((a) => {
        const e = a.json.entry;
        if (!live || !a.ok || !e) return;
        const read = Array.isArray(e.read) ? e.read.join(", ") : "";
        const write = Array.isArray(e.write) ? e.write.join(", ") : "";
        setTitle(
          [`Token ${identity.auth}`, e.description ? String(e.description) : "", `read: ${read || "none"}`, `write: ${write || "none"}`, e.ddl ? "ddl" : "", e.maintain ? "maintain" : ""]
            .filter(Boolean)
            .join("\n"),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, isOwner, identity.auth]);

  return (
    <header class="shell-header">
      <a class="shell-brand" href={href("home")}>
        Datanotes <span class="ui-muted">{identity.version}</span>
      </a>
      <Search />
      <div class="shell-header-right">
        {isOwner ? <ViewAsSelect /> : null}
        <Badge kind={isOwner ? "warn" : "info"} title={title}>
          {identity.auth}
        </Badge>
        <button
          type="button"
          class="shell-signout"
          onClick={() => {
            signOut();
            navigate("login", {}, {}, true);
            location.reload();
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
