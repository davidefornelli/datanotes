// Sidebar labels in title case (the writing guidelines: sentence case for page headings, title
// case for navigation), whatever the page's own title. Words with code, capitals or digits
// ("HTTP", "JavaScript", "ref_by") are kept as written.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);

export function titleCase(label: string): string {
  return label
    .split(" ")
    .map((word, i, words) => {
      if (word === "" || /[A-Z0-9_`.\/]/.test(word.slice(1)) || /[^a-z]/.test(word[0]!)) return word;
      if (i > 0 && i < words.length - 1 && SMALL.has(word)) return word;
      return word[0]!.toUpperCase() + word.slice(1);
    })
    .join(" ");
}

type Entry = { type: string; label: string; entries?: Entry[] };

function relabel(entries: Entry[]): void {
  for (const e of entries) {
    e.label = titleCase(e.label);
    if (e.entries) relabel(e.entries);
  }
}

export const onRequest = defineRouteMiddleware((context) => {
  relabel(context.locals.starlightRoute.sidebar as Entry[]);
});
