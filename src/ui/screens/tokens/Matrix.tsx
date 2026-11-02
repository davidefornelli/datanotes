import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Badge, Button, EmptyState } from "../../components";
import { href, type Route } from "../../lib/router";
import { useApp } from "../../state";
import { Show, useAnswer } from "./common";

/** The answer of /tokens/permissions/ (src/server/tokens.ts). */
export interface PermissionsAnswer {
  objects: { name: string; kind: "table" | "view"; reads?: string[]; reads_complete?: boolean }[];
  tokens: {
    name: string;
    read: string[];
    write: string[];
    ddl: boolean;
    maintain: boolean;
    access: { object: string; read: boolean; write: boolean; read_pattern?: string; write_pattern?: string; reason?: string }[];
  }[];
}

type MatrixObject = PermissionsAnswer["objects"][number];
type Access = PermissionsAnswer["tokens"][number]["access"][number];

/** Matrices larger than this start with their groups collapsed. */
const COLLAPSE_OVER = 200;

interface Cell {
  text: "RW" | "R" | "W" | "—";
  title: string;
}

function ownerCell(o: MatrixObject): Cell {
  return o.kind === "table" ? { text: "RW", title: "the owner reads and writes every table" } : { text: "R", title: "the owner reads every view; views are not written" };
}

function tokenCell(a: Access | undefined): Cell {
  if (!a) return { text: "—", title: "" };
  const text = a.read && a.write ? "RW" : a.read ? "R" : a.write ? "W" : "—";
  const title = a.reason ?? ([...new Set([a.read_pattern, a.write_pattern].filter((p): p is string => typeof p === "string"))].join(", ") || "no pattern matches");
  return { text, title };
}

function groupOf(name: string): string {
  return name.split(".").slice(0, 2).join(".");
}

interface Picked {
  object: MatrixObject;
  /** null: the owner. */
  token: string | null;
  access?: Access;
}

/** #/matrix: every table and view, and what the owner and each token may do with it. */
export function MatrixScreen(_props: { route: Route }): JSX.Element {
  const { api } = useApp();
  const loaded = useAnswer(() => api.route<PermissionsAnswer>("/tokens/permissions/"), [api]);
  const [text, setText] = useState("");
  const [only, setOnly] = useState("");
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Picked | null>(null);

  return (
    <div class="tokens-screen">
      <h1>Permission matrix</h1>
      <p class="ui-muted">
        What the engine lets each credential do: RW reads and writes, R only reads, — neither. Click a cell for the reason. <a href={href("tokens")}>Tokens</a>
      </p>
      <Show loaded={loaded}>
        {(m) => {
          if (m.objects.length === 0) return <EmptyState title="No tables or views" />;
          const collapsedByDefault = m.objects.length > COLLAPSE_OVER;
          const tokens = only ? m.tokens.filter((t) => t.name === only) : m.tokens;
          const byToken = new Map(m.tokens.map((t) => [t.name, new Map(t.access.map((a) => [a.object, a]))]));
          const needle = text.trim().toLowerCase();
          const shown = m.objects.filter((o) => !needle || o.name.toLowerCase().includes(needle));
          const groups: { group: string; objects: MatrixObject[] }[] = [];
          for (const o of shown) {
            const g = groupOf(o.name);
            const last = groups[groups.length - 1];
            if (last && last.group === g) last.objects.push(o);
            else groups.push({ group: g, objects: [o] });
          }
          const open = (g: string) => (collapsedByDefault ? toggled.has(g) : !toggled.has(g)) || needle !== "";
          const flip = (g: string) => {
            const next = new Set(toggled);
            if (next.has(g)) next.delete(g);
            else next.add(g);
            setToggled(next);
          };
          return (
            <>
              <div class="tokens-filters">
                <input type="search" placeholder="Filter objects" aria-label="Filter objects" value={text} onInput={(e) => setText(e.currentTarget.value)} />
                <select aria-label="Token" value={only} onChange={(e) => setOnly(e.currentTarget.value)}>
                  <option value="">Every token</option>
                  {m.tokens.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div class="tokens-matrix-wrap">
                <div class="ui-table-wrap tokens-matrix-table">
                  <table class="ui-table tokens-matrix">
                    <thead>
                      <tr>
                        <th>Object</th>
                        <th>owner</th>
                        {tokens.map((t) => (
                          <th key={t.name}>
                            <a href={href("token", { name: t.name })}>{t.name}</a>
                            {t.ddl ? (
                              <>
                                {" "}
                                <Badge kind="warn">ddl</Badge>
                              </>
                            ) : null}
                            {t.maintain ? (
                              <>
                                {" "}
                                <Badge kind="warn">maintain</Badge>
                              </>
                            ) : null}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map(({ group, objects }) => [
                        <tr key={`g:${group}`} class="tokens-matrix-group">
                          <th colSpan={2 + tokens.length}>
                            <button type="button" class="tokens-matrix-toggle" aria-expanded={open(group)} onClick={() => flip(group)}>
                              {open(group) ? "▾" : "▸"} {group} <span class="ui-muted">({objects.length})</span>
                            </button>
                          </th>
                        </tr>,
                        ...(open(group)
                          ? objects.map((o) => {
                              const owner = ownerCell(o);
                              return (
                                <tr key={o.name}>
                                  <td>
                                    <code>{o.name.slice(group.length + 1)}</code> {o.kind === "view" ? <span class="ui-muted">view</span> : null}
                                  </td>
                                  <td>
                                    <button type="button" class="tokens-cell" title={owner.title} onClick={() => setPicked({ object: o, token: null })}>
                                      {owner.text}
                                    </button>
                                  </td>
                                  {tokens.map((t) => {
                                    const a = byToken.get(t.name)?.get(o.name);
                                    const c = tokenCell(a);
                                    return (
                                      <td key={t.name}>
                                        <button
                                          type="button"
                                          class={`tokens-cell tokens-cell-${c.text === "—" ? "none" : c.text.toLowerCase()}`}
                                          title={c.title}
                                          onClick={() => setPicked(a ? { object: o, token: t.name, access: a } : { object: o, token: t.name })}
                                        >
                                          {c.text}
                                        </button>
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })
                          : []),
                      ])}
                    </tbody>
                  </table>
                </div>
                {picked ? <Explain picked={picked} onClose={() => setPicked(null)} /> : null}
              </div>
            </>
          );
        }}
      </Show>
    </div>
  );
}

/** The side panel: why a credential may or may not read and write one object. */
function Explain(props: { picked: Picked; onClose(): void }): JSX.Element {
  const { object: o, token, access: a } = props.picked;
  return (
    <aside class="tokens-explain" aria-label="Explanation">
      <div class="tokens-head">
        <h2>
          {token ?? "owner"} on <code>{o.name}</code>
        </h2>
        <Button onClick={props.onClose}>Close</Button>
      </div>
      <p>A {o.kind}.</p>
      {o.kind === "view" && o.reads ? (
        <p>
          It reads {o.reads.length ? o.reads.join(", ") : "no table"}
          {o.reads_complete === false ? ", and tables known only when it runs" : ""}.
        </p>
      ) : null}
      {token === null ? (
        <p>{ownerCell(o).title}.</p>
      ) : !a ? (
        <p>The engine gave no answer for this token and object.</p>
      ) : (
        <ul>
          <li>{a.read ? `Reads it: read pattern ${a.read_pattern ?? "(every table)"}.` : `Does not read it${a.reason ? `: ${a.reason}` : ": no read pattern matches"}.`}</li>
          <li>{a.write ? `Writes it: write pattern ${a.write_pattern ?? ""}.` : o.kind === "view" ? "Views are not written." : "Does not write it: no write pattern matches."}</li>
        </ul>
      )}
    </aside>
  );
}
