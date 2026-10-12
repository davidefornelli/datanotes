// The Markdown twin of a page: /start/quick-start/ -> /start/quick-start.md, the home page -> /index.md.
// docs/worker.js keeps its own copy of this rule (the worker is deployed on its own); tests check both.

/** @param {string} pathname a page's path, with or without the trailing slash */
export function markdownPathOf(pathname) {
  const route = pathname.replace(/\/+$/, "");
  return route === "" ? "/index.md" : `${route}.md`;
}
