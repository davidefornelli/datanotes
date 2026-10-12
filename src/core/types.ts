/** Shared domain types for Datanotes. */

/** One frontmatter property, in file order. */
export type OrderedFrontmatterEntry = readonly [string, unknown];
/** A note's frontmatter as ordered key / value pairs. */
export type OrderedFrontmatter = readonly OrderedFrontmatterEntry[];
