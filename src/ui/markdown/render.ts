/**
 * Note bodies as HTML that can never run script (plan D7). markdown-it with `html: false` never
 * emits raw HTML; this module adds the link and image policy and Obsidian wiki-links:
 *
 * - links: `http:`, `https:`, `mailto:` open outside (`target="_blank"`, `rel="noopener noreferrer
 *   nofollow"`); scheme-less links are vault links (`href="#"`, the target in `data-vault-link`);
 *   any other scheme (`javascript:`, `data:`, `vbscript:`, `file:`, ...) is not a link at all.
 * - images: only `data:image/(png|gif|jpeg|webp);...`; any other image is the text `[image: alt]`.
 * - wiki-links `[[target|alias]]` and embeds `![[target]]` are in-app links (`data-wikilink`).
 *
 * Every attribute goes through markdown-it's escaping. MarkdownView.tsx injects the result.
 */

import MarkdownIt from "markdown-it";

/** Bodies longer than this are shown as escaped plain text: rendering them would stall the tab. */
export const MAX_MARKDOWN_CHARS = 500_000;

const EXTERNAL = /^(https?:|mailto:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DATA_IMAGE = /^data:image\/(png|gif|jpeg|webp);/i;

interface WikiLinkMeta {
  target: string;
  alias: string | undefined;
  embed: boolean;
}

const BANG = 0x21; // !
const OPEN = 0x5b; // [
const CLOSE = 0x5d; // ]
const NEWLINE = 0x0a;

/** Inline rule: `[[target|alias]]` or `![[target|alias]]`, on one line, no `[` or `]` inside. */
function wikilink(state: MarkdownIt.StateInline, silent: boolean): boolean {
  const src = state.src;
  const max = state.posMax;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === BANG;
  if (embed) pos++;
  if (src.charCodeAt(pos) !== OPEN || src.charCodeAt(pos + 1) !== OPEN) return false;
  const start = pos + 2;
  let end = start;
  for (; end < max; end++) {
    const c = src.charCodeAt(end);
    if (c === CLOSE) break;
    if (c === OPEN || c === NEWLINE) return false;
  }
  if (end + 1 >= max || src.charCodeAt(end + 1) !== CLOSE) return false;
  const inner = src.slice(start, end);
  const bar = inner.indexOf("|");
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  if (!target) return false;
  const alias = bar < 0 ? undefined : inner.slice(bar + 1).trim() || undefined;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    const meta: WikiLinkMeta = { target, alias, embed };
    token.meta = meta;
  }
  state.pos = end + 2;
  return true;
}

/**
 * Core rule: a link whose target is a `data:` URL (allowed by validateLink only so that images can
 * use one) is not a link: its tokens are dropped and its text stays.
 */
function dropDataLinks(state: MarkdownIt.StateCore): void {
  for (const block of state.tokens) {
    const children = block.children;
    if (!children) continue;
    let dropping = false;
    block.children = children.filter((t) => {
      if (t.type === "link_open" && /^data:/i.test(href(t))) {
        dropping = true;
        return false;
      }
      if (t.type === "link_close" && dropping) {
        dropping = false;
        return false;
      }
      return true;
    });
  }
}

/** A link token's href: markdown-it's link rules always set it. */
function href(token: MarkdownIt.Token): string {
  return token.attrGet("href") as string;
}

function decoded(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** A new renderer with the policy of this module (plan D7). */
export function createRenderer(): MarkdownIt {
  const md = new MarkdownIt("default", { html: false, linkify: false, typographer: false, breaks: false });
  const esc = md.utils.escapeHtml;

  // markdown-it calls this on the normalized (percent-encoded) URL of links and images.
  md.validateLink = (url: string): boolean => {
    const u = url.trim();
    return EXTERNAL.test(u) || DATA_IMAGE.test(u) || !ANY_SCHEME.test(u);
  };

  md.inline.ruler.before("link", "wikilink", wikilink);
  md.core.ruler.after("inline", "drop_data_links", dropDataLinks);

  md.renderer.rules.wikilink = (tokens, idx) => {
    const { target, alias, embed } = tokens[idx]!.meta as WikiLinkMeta;
    const text = esc(alias ?? target);
    return embed
      ? `<a href="#" class="wikilink embed" data-wikilink="${esc(target)}">[embed: ${text}]</a>`
      : `<a href="#" class="wikilink" data-wikilink="${esc(target)}">${text}</a>`;
  };

  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!;
    const url = href(token);
    if (EXTERNAL.test(url)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer nofollow");
    } else {
      token.attrSet("href", "#");
      token.attrSet("data-vault-link", decoded(url));
      token.attrSet("class", "vault-link");
    }
    return self.renderToken(tokens, idx, options);
  };

  const image = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const src = token.attrGet("src") as string; // the image rule always sets it
    if (DATA_IMAGE.test(src)) return image(tokens, idx, options, env, self);
    const alt = self.renderInlineAsText(token.children as MarkdownIt.Token[], options, env);
    return `<span class="md-image">[image: ${esc(alt || src)}]</span>`;
  };

  return md;
}

let renderer: MarkdownIt | null = null;

/** A note body as safe HTML; over MAX_MARKDOWN_CHARS, the escaped text in a `<pre>`. */
export function renderMarkdown(text: string): string {
  renderer ??= createRenderer();
  if (text.length > MAX_MARKDOWN_CHARS) return `<pre class="md-plain">${renderer.utils.escapeHtml(text)}</pre>`;
  return renderer.render(text);
}
