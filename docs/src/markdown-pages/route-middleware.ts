// Links every page to its Markdown twin in <head>: <link rel="alternate" type="text/markdown" href="/….md">.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { markdownPathOf } from "./paths.js";

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  if (route.entry.id === "404") return;
  route.head.push({ tag: "link", attrs: { rel: "alternate", type: "text/markdown", href: markdownPathOf(context.url.pathname) } });
});
