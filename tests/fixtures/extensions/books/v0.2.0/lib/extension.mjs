// The books fixture extension of the engine's tests: hand-written ES module, no imports.
class ToolError extends Error {
  constructor(message, hint, docs) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
    this.docs = docs;
  }
}
const rows = async (ctx, args) => {
  const r = await ctx.callTool("select_rows", args);
  if (!r.ok) throw new ToolError(String(r.value));
  return r.value.rows;
};
export default {
  api: 1,
  handlers: {
    async list_reading(_args, ctx) {
      const book = ctx.table("book");
      const found = await rows(ctx, { table: book, where: { status: "reading" }, columns: ["title", "author"], order_by: ["title"] });
      return { table: book, books: found.map((r) => ({ title: r.title, author: r.author ?? null })), timezone: ctx.timezone, harness: ctx.actor().harness ?? null };
    },
    async finish_book(args, ctx) {
      const book = ctx.table("book");
      const found = await rows(ctx, { table: book, where: { title: args.title }, columns: ["title"] });
      if (found.length !== 1) throw new ToolError(`no book titled "${args.title}"`, "Call list_reading, or select_rows on the book table, to find the title as written.", "tools#finish_book");
      const set = { status: "read", finished_on: new Date().toISOString().slice(0, 10), ...(args.rating !== undefined ? { rating: args.rating } : {}) };
      const r = await ctx.callTool("update_row", { table: book, path: found[0].path, set });
      if (!r.ok) throw new ToolError(String(r.value));
      return { path: found[0].path, status: "read", migration_id: r.value.migration_id ?? null };
    },
  },
};
