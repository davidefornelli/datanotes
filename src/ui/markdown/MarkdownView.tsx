import { useMemo } from "preact/hooks";
import { renderMarkdown } from "./render";
import "./markdown.css";

interface MarkdownViewProps {
  text: string;
  /** A wiki-link (`[[target]]`) or vault link (`[x](Other.md)`) was clicked: its target, as written. */
  onOpenLink?(target: string): void;
}

/** A note body rendered as Markdown, with in-app links (plan D7). */
export function MarkdownView(props: MarkdownViewProps) {
  const html = useMemo(() => renderMarkdown(props.text), [props.text]);
  function onClick(event: MouseEvent) {
    const root = event.currentTarget as HTMLElement;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest("a[data-wikilink], a[data-vault-link]");
    if (!link || !root.contains(link)) return;
    event.preventDefault();
    const value = link.getAttribute("data-wikilink") ?? link.getAttribute("data-vault-link") ?? "";
    props.onOpenLink?.(value);
  }
  // The only HTML injection of the UI: render.ts emits no raw HTML (html: false) and escapes every
  // attribute. tests/ui-no-inner-html.test.ts forbids it anywhere else.
  return <div class="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
