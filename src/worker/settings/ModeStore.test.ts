import { afterEach, describe, expect, it, vi } from "vitest";

import { ChromeModeStore, computeEffectiveMode } from "./ModeStore";

type ChromeStub = {
  storage?: {
    local?: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
};

function installChrome(stub: ChromeStub) {
  (globalThis as { chrome?: ChromeStub }).chrome = stub;
}

/** Map-backed chrome.storage.local stub so set/get round-trip for real. */
function installInMemoryStorage(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  installChrome({
    storage: {
      local: {
        get: async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            data.set(key, value);
          }
        },
      },
    },
  });
  return data;
}

afterEach(() => {
  delete (globalThis as { chrome?: ChromeStub }).chrome;
});

describe("ChromeModeStore", () => {
  it("defaults to hybrid when chrome.storage is unavailable", async () => {
    const store = new ChromeModeStore();
    await expect(store.getStoredMode()).resolves.toBe("hybrid");
  });

  it("defaults to hybrid when no value is stored", async () => {
    installChrome({
      storage: { local: { get: async () => ({}), set: async () => {} } },
    });
    const store = new ChromeModeStore();
    await expect(store.getStoredMode()).resolves.toBe("hybrid");
  });

  it.each(["local", "hybrid"] as const)("returns the stored mode %s", async (mode) => {
    installChrome({
      storage: { local: { get: async () => ({ search_mode: mode }), set: async () => {} } },
    });
    const store = new ChromeModeStore();
    await expect(store.getStoredMode()).resolves.toBe(mode);
  });

  it("falls back to hybrid when the stored value is not a valid mode", async () => {
    installChrome({
      storage: {
        local: { get: async () => ({ search_mode: "keyword_fallback" }), set: async () => {} },
      },
    });
    const store = new ChromeModeStore();
    await expect(store.getStoredMode()).resolves.toBe("hybrid");
  });

  it("falls back to hybrid when the storage read throws", async () => {
    installChrome({
      storage: {
        local: {
          get: async () => {
            throw new Error("storage corrupted");
          },
          set: async () => {},
        },
      },
    });
    const store = new ChromeModeStore();
    await expect(store.getStoredMode()).resolves.toBe("hybrid");
  });

  it("persists the choice via setStoredMode", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    installChrome({ storage: { local: { get: async () => ({}), set } } });
    const store = new ChromeModeStore();

    await store.setStoredMode("local");

    expect(set).toHaveBeenCalledWith({ search_mode: "local" });
  });

  it("rejects keyword_fallback instead of persisting it", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    installChrome({ storage: { local: { get: async () => ({}), set } } });
    const store = new ChromeModeStore();

    await expect(store.setStoredMode("keyword_fallback" as never)).rejects.toThrow(
      "Invalid stored mode",
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("setStoredMode throws when chrome.storage is unavailable", async () => {
    const store = new ChromeModeStore();
    await expect(store.setStoredMode("hybrid")).rejects.toThrow("Chrome storage is unavailable");
  });

  it("round-trips a stored mode through chrome.storage", async () => {
    installInMemoryStorage();
    const store = new ChromeModeStore();

    await store.setStoredMode("local");
    await expect(store.getStoredMode()).resolves.toBe("local");

    await store.setStoredMode("hybrid");
    await expect(store.getStoredMode()).resolves.toBe("hybrid");
  });
});

describe("getEffectiveMode", () => {
  function storeWithMode(mode: string | undefined) {
    installChrome({
      storage: {
        local: {
          get: async () => (mode === undefined ? {} : { search_mode: mode }),
          set: async () => {},
        },
      },
    });
    return new ChromeModeStore();
  }

  it.each([
    { mode: "hybrid", hasApiKey: true, expected: "hybrid" },
    { mode: "hybrid", hasApiKey: false, expected: "local" },
    { mode: "local", hasApiKey: true, expected: "local" },
    { mode: "local", hasApiKey: false, expected: "local" },
  ] as const)(
    "stored $mode with key=$hasApiKey resolves to $expected",
    async ({ mode, hasApiKey, expected }) => {
      const store = storeWithMode(mode);
      await expect(store.getEffectiveMode(hasApiKey)).resolves.toBe(expected);
    },
  );

  it("uses the default stored mode when nothing is stored", async () => {
    const store = storeWithMode(undefined);
    await expect(store.getEffectiveMode(false)).resolves.toBe("local");
    await expect(store.getEffectiveMode(true)).resolves.toBe("hybrid");
  });

  it("still resolves when chrome.storage is unavailable", async () => {
    const store = new ChromeModeStore();
    await expect(store.getEffectiveMode(false)).resolves.toBe("local");
    await expect(store.getEffectiveMode(true)).resolves.toBe("hybrid");
  });

  it("does not overwrite a hybrid preference while a key is unavailable", async () => {
    const data = installInMemoryStorage({ search_mode: "hybrid" });
    const store = new ChromeModeStore();

    await expect(store.getEffectiveMode(false)).resolves.toBe("local");
    expect(data.get("search_mode")).toBe("hybrid");

    await expect(store.getEffectiveMode(true)).resolves.toBe("hybrid");
    expect(data.get("search_mode")).toBe("hybrid");
  });
});

describe("getDefaultEffectiveMode", () => {
  it("is local when there is no API key", () => {
    expect(new ChromeModeStore().getDefaultEffectiveMode(false)).toBe("local");
  });

  it("is hybrid when an API key is available", () => {
    expect(new ChromeModeStore().getDefaultEffectiveMode(true)).toBe("hybrid");
  });
});

describe("computeEffectiveMode", () => {
  it.each([
    { stored: "local", hasApiKey: false, expected: "local" },
    { stored: "local", hasApiKey: true, expected: "local" },
    { stored: "hybrid", hasApiKey: false, expected: "local" },
    { stored: "hybrid", hasApiKey: true, expected: "hybrid" },
  ] as const)(
    "stored $stored + hasApiKey $hasApiKey -> $expected",
    ({ stored, hasApiKey, expected }) => {
      expect(computeEffectiveMode(stored, hasApiKey)).toBe(expected);
    },
  );
});
