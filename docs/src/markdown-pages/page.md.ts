// /<route>.md for every page (plugin.js): the content pages (src/content/docs, hand-written and
// generated) and the HTTP API pages of starlight-openapi. Links point to the site's pages, absolute.
import type { APIContext, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";
// starlight-llms-txt's converter (the one behind llms-full.txt): renders the page, MDX components
// included, then turns the HTML into Markdown (code blocks with their language, tabs as lists).
import { entryToSimpleMarkdown } from "datanotes:llms-txt-markdown";
// starlight-openapi's own list of its pages, so the .md pages are exactly its pages
import { getSchemaStaticPaths } from "datanotes:openapi-routes";
import { openAPIPageToMarkdown, type OpenAPIRoute } from "./openapi";

export const prerender = true;

type Props = { entry: CollectionEntry<"docs"> } | { route: OpenAPIRoute };

export const getStaticPaths = (async () => {
  const docs = await getCollection("docs", (doc) => !doc.data.draft);
  return [
    ...docs.map((entry) => ({ params: { slug: entry.id }, props: { entry } })),
    ...(getSchemaStaticPaths() as OpenAPIRoute[]).map((route) => ({ params: { slug: route.params.openAPISlug }, props: { route } })),
  ];
}) satisfies GetStaticPaths;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

async function contentPage(entry: CollectionEntry<"docs">, context: APIContext): Promise<string> {
  const { title, description, hero } = entry.data;
  const parts = [`# ${oneLine(title)}`];
  if (description) parts.push(`> ${oneLine(description)}`);
  if (hero?.tagline) parts.push(oneLine(hero.tagline));
  if (hero?.actions?.length) parts.push(hero.actions.map((a) => `- [${a.text}](${a.link})`).join("\n"));
  parts.push(await entryToSimpleMarkdown(entry, context));
  return parts.join("\n\n");
}

/** Root-relative links (`](/guides/tokens/)`) made absolute, outside code blocks. */
function absoluteLinks(markdown: string, site: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence === null && marker) fence = marker;
      else if (fence !== null && marker && line.trim() === marker) fence = null;
      else if (fence === null) return line.replace(/\]\(\/(?!\/)/g, `](${site}/`).replace(/^(\s*\[[^\]]+\]:\s*)\/(?!\/)/, `$1${site}/`);
      return line;
    })
    .join("\n");
}

export async function GET(context: APIContext) {
  const props = context.props as Props;
  const site = (context.site?.origin ?? "").replace(/\/$/, "");
  const markdown = "entry" in props ? await contentPage(props.entry, context) : openAPIPageToMarkdown(props.route, getSchemaStaticPaths() as OpenAPIRoute[], site);
  return new Response(`${absoluteLinks(markdown, site).trim()}\n`, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
