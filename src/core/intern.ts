/**
 * One copy of each string the engine keeps per note. A front matter value, a key, a tag, a link
 * target, a path: the same texts come back in thousands of notes, each parse making its own copy.
 * {@link intern} hands them to V8's string table, which keeps one copy of each text: a keyed store
 * puts its key there (or finds the copy already there) and turns the string into a forward to that
 * copy, and the garbage collector then points every holder at it. The table is weak: a string no
 * note holds any more is collected, so nothing is pinned and nothing needs cleaning. Interning a
 * piece cut from a text also lets the text go. Integer-like strings ("12") are array indexes, not
 * keys: they stay as they are (harmless).
 */

/** Strings longer than this are not interned: a long text rarely repeats. Tests change it. */
export const INTERN = { maxLength: 128 };

/** The keyed store's target: always empty (each key is deleted at once). */
const TABLE: Record<string, number> = Object.create(null) as Record<string, number>;

/** The string, held by V8 as its one copy of that text (see the module comment); longer than INTERN.maxLength: as it is. */
export function intern(s: string): string {
  if (s.length > INTERN.maxLength) return s;
  TABLE[s] = 0;
  delete TABLE[s];
  return s;
}

/**
 * Intern, in place, every string of a value made fresh (JSON.parse of the index on disk): array
 * elements and the values of plain objects, at any depth. An object's keys need nothing: V8 keeps
 * property names in its string table already. Other objects (a Date) are left as they are. Returns
 * the value (a string: its interned copy).
 */
export function internAll<T>(v: T): T {
  if (typeof v === "string") return intern(v) as unknown as T;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = internAll(v[i]);
  } else if (v !== null && typeof v === "object") {
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto === Object.prototype || proto === null) {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = internAll(o[k]);
    }
  }
  return v;
}
