/**
 * The database browser's Markdown (src/ui/markdown/render.ts, plan D7): note bodies become HTML that
 * can never run script; links and images follow the policy; wiki-links are in-app links.
 */

import { describe, expect, it } from "vitest";
import { createRenderer, MAX_MARKDOWN_CHARS, renderMarkdown } from "../src/ui/markdown/render";

describe("renderMarkdown: no script, ever", () => {
  it("escapes raw HTML", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
    expect(renderMarkdown("a <b>bold</b> word")).toBe("<p>a &lt;b&gt;bold&lt;/b&gt; word</p>\n");
  });

  it.each([
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](data:text/html;base64,PHM+)",
    "[x](vbscript:x)",
    "[x](file:///etc/passwd)",
    "[x](obsidian://open?vault=v)",
    "[x](&#106;avascript:alert(1))",
    "<javascript:alert(1)>",
  ])("%s is not a link", (src) => {
    expect(renderMarkdown(src)).not.toContain("<a");
  });

  it("a data: image URL in a link is not a link: the text stays", () => {
    expect(renderMarkdown("[pic](data:image/png;base64,iVBORw0KGgo=) after")).toBe("<p>pic after</p>\n");
  });

  it("escapes a fence's HTML", () => {
    const out = renderMarkdown("```html\n<b>x</b>\n```");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("shows text over the limit as escaped plain text", () => {
    const text = "<i>" + "a".repeat(MAX_MARKDOWN_CHARS) + "\n# not a heading";
    const out = renderMarkdown(text);
    expect(out.startsWith('<pre class="md-plain">&lt;i&gt;aaa')).toBe(true);
    expect(out.endsWith("\n# not a heading</pre>")).toBe(true);
    expect(out).not.toContain("<h1");
    expect(renderMarkdown("a".repeat(MAX_MARKDOWN_CHARS))).toBe(`<p>${"a".repeat(MAX_MARKDOWN_CHARS)}</p>\n`);
  });
});

describe("renderMarkdown: links", () => {
  it("opens http, https and mailto outside", () => {
    expect(renderMarkdown("[ok](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">ok</a></p>\n',
    );
    expect(renderMarkdown("[h](HTTP://example.com/a?b=1&c=2)")).toBe(
      '<p><a href="HTTP://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">h</a></p>\n',
    );
    expect(renderMarkdown("<mailto:me@example.com>")).toBe(
      '<p><a href="mailto:me@example.com" target="_blank" rel="noopener noreferrer nofollow">mailto:me@example.com</a></p>\n',
    );
  });

  it("keeps vault links in the app, decoded", () => {
    expect(renderMarkdown("[n](Other%20note.md)")).toBe(
      '<p><a href="#" data-vault-link="Other note.md" class="vault-link">n</a></p>\n',
    );
    expect(renderMarkdown("[n](<Folder/My note.md>)")).toContain('data-vault-link="Folder/My note.md"');
    expect(renderMarkdown('[n](a"b.md)')).toContain('data-vault-link="a&quot;b.md"');
  });

  it("keeps the raw link when it does not decode", () => {
    expect(renderMarkdown("[n](%E0%A4%A)")).toContain('data-vault-link="%E0%A4%25A"');
  });
});

describe("renderMarkdown: wiki-links", () => {
  it("renders [[Note]] and [[Note|Alias]] as in-app links", () => {
    expect(renderMarkdown("[[Note|Alias]]")).toBe('<p><a href="#" class="wikilink" data-wikilink="Note">Alias</a></p>\n');
    expect(renderMarkdown("see [[ Folder/Note ]] now")).toBe(
      '<p>see <a href="#" class="wikilink" data-wikilink="Folder/Note">Folder/Note</a> now</p>\n',
    );
    expect(renderMarkdown("[[Note|]]")).toContain(">Note</a>");
    expect(renderMarkdown("[[Note|a|b]]")).toContain('data-wikilink="Note">a|b</a>');
  });

  it("escapes the target and the alias", () => {
    const out = renderMarkdown('[[x" onmouseover="alert(1)]]');
    expect(out).not.toMatch(/\son\w+="/);
    expect(out).toContain("&quot;");
    expect(renderMarkdown("[[a|<script>]]")).toContain(">&lt;script&gt;</a>");
  });

  it("renders embeds as a placeholder link", () => {
    expect(renderMarkdown("![[photo.png]]")).toBe(
      '<p><a href="#" class="wikilink embed" data-wikilink="photo.png">[embed: photo.png]</a></p>\n',
    );
    expect(renderMarkdown("![[photo.png|My photo]]")).toContain(">[embed: My photo]</a>");
  });

  it.each([
    ["[[]]", "<p>[[]]</p>\n"],
    ["[[ | alias]]", "<p>[[ | alias]]</p>\n"],
    ["[[open", "<p>[[open</p>\n"],
    ["[[a]", "<p>[[a]</p>\n"],
    ["[[a]b]]", "<p>[[a]b]]</p>\n"],
    ["[[a[b]]", "<p>[[a[b]]</p>\n"],
    ["[[a\nb]]", "<p>[[a\nb]]</p>\n"],
    ["![x", "<p>![x</p>\n"],
    ["! [[a]]", '<p>! <a href="#" class="wikilink" data-wikilink="a">a</a></p>\n'],
  ])("%j is not a wiki-link unless well formed", (src, html) => {
    expect(renderMarkdown(src)).toBe(html);
  });

  it("a wiki-link inside a link's label makes no nested link: the wiki-link wins", () => {
    expect(renderMarkdown("[see [[Note]] here](x.md)")).toBe(
      '<p>[see <a href="#" class="wikilink" data-wikilink="Note">Note</a> here](x.md)</p>\n',
    );
  });

  it("a wiki-link inside an image's description is skipped as one piece", () => {
    expect(renderMarkdown("![see [[Note]] here](x.png)")).toBe('<p><span class="md-image">[image: see  here]</span></p>\n');
  });

  it("is not parsed inside code", () => {
    expect(renderMarkdown("`[[Note]]`")).toBe("<p><code>[[Note]]</code></p>\n");
  });
});

describe("renderMarkdown: images", () => {
  it("blocks remote and relative images", () => {
    const out = renderMarkdown("![](https://evil.example/p.png)");
    expect(out).not.toContain("<img");
    expect(out).toBe('<p><span class="md-image">[image: https://evil.example/p.png]</span></p>\n');
    expect(renderMarkdown("![a *b*](pic.png)")).toBe('<p><span class="md-image">[image: a b]</span></p>\n');
    expect(renderMarkdown("![<x>](javascript:alert(1))")).not.toContain("<img");
    expect(renderMarkdown("![s](data:image/svg+xml;base64,PHN2Zz4=)")).not.toContain("<img");
  });

  it("shows data: images of the raster types", () => {
    expect(renderMarkdown("![a](data:image/png;base64,iVBORw0KGgo=)")).toBe(
      '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="a"></p>\n',
    );
    for (const type of ["gif", "jpeg", "webp", "PNG"]) {
      expect(renderMarkdown(`![a](data:image/${type};base64,AAAA)`)).toContain(`<img src="data:image/${type};`);
    }
  });
});

describe("createRenderer", () => {
  it("makes independent renderers with the same policy", () => {
    const a = createRenderer();
    const b = createRenderer();
    expect(a).not.toBe(b);
    expect(a.options.html).toBe(false);
    expect(a.options.linkify).toBe(false);
    expect(a.render("[x](javascript:alert(1))")).not.toContain("<a");
    expect(a.render("[[N]]")).toBe(renderMarkdown("[[N]]"));
  });
});
