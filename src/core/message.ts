/** The text of a thrown value: an Error's message, anything else (a string, a host's object) as a string. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
