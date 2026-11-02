import type { JSX } from "preact";
import { basename, displayValue, linkTarget } from "../lib/format";
import { href } from "../lib/router";

export interface ValueViewProps {
  value: unknown;
  type?: string;
  /** The note the value belongs to: its links resolve from there. */
  fromPath?: string;
}

function LinkChip(props: { text: string; fromPath?: string }): JSX.Element {
  const target = linkTarget(props.text) ?? props.text;
  const to = props.fromPath ? href("open", {}, { from: props.fromPath, link: props.text }) : href("open", {}, { path: target });
  return (
    <a class="ui-chip ui-chip-link" href={to} title={target}>
      {basename(target)}
    </a>
  );
}

/** A value of a row: links as chips that open their note, lists as chips, JSON as code. */
export function ValueView(props: ValueViewProps): JSX.Element {
  const v = props.value;
  if (v === null || v === undefined || v === "") return <span class="ui-value-empty" />;
  if (Array.isArray(v)) {
    return (
      <span class="ui-chips">
        {v.map((item, i) =>
          typeof item === "string" && linkTarget(item) ? (
            <LinkChip key={i} text={item} fromPath={props.fromPath} />
          ) : (
            <span key={i} class="ui-chip">
              {displayValue(item)}
            </span>
          ),
        )}
      </span>
    );
  }
  if (typeof v === "string" && (linkTarget(v) || props.type === "link")) return <LinkChip text={v} fromPath={props.fromPath} />;
  if (typeof v === "object" || props.type === "json") return <code class="ui-value-json">{JSON.stringify(v)}</code>;
  if (typeof v === "boolean") return <span class="ui-value-bool">{v ? "true" : "false"}</span>;
  return <span class="ui-value">{displayValue(v)}</span>;
}
