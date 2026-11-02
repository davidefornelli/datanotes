/**
 * Where the database browser keeps the token (src/ui/lib/auth.ts): the tab's storage first, the
 * remembered one when the user asked, never both; a storage that throws means memory only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_KEY, clearToken, loadToken, newUiSession, saveToken, storages, type StorageLike } from "../src/ui/lib/auth";

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const broken: StorageLike = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

describe("token storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the tab's token first, then the remembered one", () => {
    const s = mem();
    const l = mem();
    expect(loadToken(s, l)).toBeNull();
    l.setItem(TOKEN_KEY, "remembered");
    expect(loadToken(s, l)).toEqual({ token: "remembered", remember: true });
    s.setItem(TOKEN_KEY, "tab");
    expect(loadToken(s, l)).toEqual({ token: "tab", remember: false });
    s.setItem(TOKEN_KEY, "");
    expect(loadToken(s, l)).toEqual({ token: "remembered", remember: true });
  });

  it("keeps the token in one storage: Remember moves it to localStorage and back", () => {
    const s = mem();
    const l = mem();
    saveToken(s, l, "a", false);
    expect([s.data.get(TOKEN_KEY), l.data.has(TOKEN_KEY)]).toEqual(["a", false]);
    saveToken(s, l, "b", true);
    expect([s.data.has(TOKEN_KEY), l.data.get(TOKEN_KEY)]).toEqual([false, "b"]);
    saveToken(s, l, "c", false);
    expect([s.data.get(TOKEN_KEY), l.data.has(TOKEN_KEY)]).toEqual(["c", false]);
    clearToken(s, l);
    expect(s.data.size + l.data.size).toBe(0);
  });

  it("ignores a storage that throws or is missing", () => {
    expect(loadToken(broken, broken)).toBeNull();
    expect(loadToken(null, null)).toBeNull();
    expect(() => saveToken(broken, broken, "x", true)).not.toThrow();
    expect(() => saveToken(null, null, "x", false)).not.toThrow();
    expect(() => clearToken(broken, null)).not.toThrow();
  });

  it("makes a ui session id of 16 hex characters", () => {
    const id = newUiSession((n) => Uint8Array.from({ length: n }, (_, i) => (i === 7 ? 0x0f : i)));
    expect(id).toBe("ui-000102030405060f");
    expect(id).toHaveLength(19);
    expect(newUiSession(() => new Uint8Array(2))).toBe("ui-0000000000000000");
    expect(newUiSession()).toMatch(/^ui-[0-9a-f]{16}$/);
  });

  it("finds the page's storages, or null when the browser refuses them", () => {
    const s = mem();
    vi.stubGlobal("sessionStorage", s);
    vi.stubGlobal("localStorage", undefined);
    expect(storages()).toEqual({ session: s, local: null });
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(storages().local).toBeNull();
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
});
