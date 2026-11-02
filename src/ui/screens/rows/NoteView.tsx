import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { EmptyState, ErrorBox, errorBodyOf, Spinner, ValueView } from "../../components";
import type { ErrorBody } from "../../lib/api";
import { basename } from "../../lib/format";
import { resolveLink } from "../../lib/open";
import { navigate, type Route } from "../../lib/router";
import { splitFrontMatter } from "../../lib/row-form";
import { MarkdownView } from "../../markdown/MarkdownView";
import { useApp } from "../../state";
import { bodyOf, opOf } from "./common";
import { LinksPanel } from "./LinksPanel";

interface Note {
  content: string;
  front_matter: Record<string, unknown>;
  modified_at?: string;
}

/** #/note?path=: a note that is not a row of a table, read only. */
export function NoteScreen(props: { route: Route }): JSX.Element {
  const { api, toast } = useApp();
  const path = props.route.query.path ?? "";
  const [note, setNote] = useState<Note | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<ErrorBody | null>(null);

  useEffect(() => {
    let live = true;
    setNote(null);
    setMissing(false);
    setError(null);
    api
      .op<Note>("read_note", { path })
      .then((a) => {
        if (!live) return;
        if (a.status === 404) setMissing(true);
        else if (!a.ok) setError(bodyOf(a));
        else setNote(a.json);
      })
      .catch((e: unknown) => live && setError(errorBodyOf(e)));
    return () => {
      live = false;
    };
  }, [api, path]);

  if (!path) return <EmptyState title="No note given" />;
  if (missing) return <EmptyState title={`No note at ${path}`} />;
  if (error) return <ErrorBox body={error} />;
  if (!note) return <Spinner />;

  const { body } = splitFrontMatter(note.content);
  const fm = Object.entries(note.front_matter ?? {});
  const openLink = async (target: string) => {
    const to = await resolveLink(opOf(api), path, target).catch(() => null);
    if (to) navigate("open", {}, { path: to });
    else toast({ text: `No note matches ${target}`, kind: "error" });
  };

  return (
    <div class="rows-screen rows-note">
      <div class="rows-head">
        <div>
          <h1 class="rows-title">{basename(path)}</h1>
          <p class="ui-muted rows-path">{path}</p>
        </div>
      </div>
      {fm.length ? (
        <table class="ui-table rows-frontmatter">
          <tbody>
            {fm.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>
                  <ValueView value={v} fromPath={path} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <MarkdownView text={body} onOpenLink={(t) => void openLink(t)} />
      <h2>Links</h2>
      <LinksPanel path={path} />
    </div>
  );
}
