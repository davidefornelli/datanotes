// Where the browser keeps the token (D5): in memory and in sessionStorage (cleared when the tab
// closes), or in localStorage when the user ticks "Remember on this browser". Never in a URL or a
// cookie. Every storage call may throw (private modes, disabled storage): a failure means the token
// lives in memory only. Pure: storages are passed in, read only when called.

export const TOKEN_KEY = "datanotes.ui.token";

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface SavedToken {
  token: string;
  remember: boolean;
}

function read(s: StorageLike | null): string | null {
  try {
    return s?.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

function write(s: StorageLike | null, token: string): void {
  try {
    s?.setItem(TOKEN_KEY, token);
  } catch {
    // memory only
  }
}

function remove(s: StorageLike | null): void {
  try {
    s?.removeItem(TOKEN_KEY);
  } catch {
    // nothing stored there
  }
}

/** The saved token: the tab's (sessionStorage) first, then the remembered one (localStorage). */
export function loadToken(session: StorageLike | null, local: StorageLike | null): SavedToken | null {
  const inTab = read(session);
  if (inTab) return { token: inTab, remember: false };
  const remembered = read(local);
  return remembered ? { token: remembered, remember: true } : null;
}

/** Saves the token in one storage and removes it from the other. */
export function saveToken(session: StorageLike | null, local: StorageLike | null, token: string, remember: boolean): void {
  write(remember ? local : session, token);
  remove(remember ? session : local);
}

export function clearToken(session: StorageLike | null, local: StorageLike | null): void {
  remove(session);
  remove(local);
}

/** "ui-" and 16 hex characters: the agent session of this page load (D11). */
export function newUiSession(random?: (n: number) => Uint8Array): string {
  const bytes = random ? random(8) : globalThis.crypto.getRandomValues(new Uint8Array(8));
  let hex = "";
  for (let i = 0; i < 8; i++) hex += ((bytes[i] ?? 0) & 0xff).toString(16).padStart(2, "0");
  return `ui-${hex}`;
}

function storage(name: "sessionStorage" | "localStorage"): StorageLike | null {
  try {
    return ((globalThis as Record<string, unknown>)[name] as StorageLike | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The page's storages; null where the browser refuses them. */
export function storages(): { session: StorageLike | null; local: StorageLike | null } {
  return { session: storage("sessionStorage"), local: storage("localStorage") };
}
