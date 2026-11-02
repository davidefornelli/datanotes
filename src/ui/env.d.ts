// esbuild bundles the stylesheets a component imports into app.css; for tsc they are modules
// without exports.
declare module "*.css";
