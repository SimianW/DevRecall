import { afterEach, describe, expect, it, vi } from "vitest";

import { ChromeAutoSaveSettingStore } from "./AutoSaveSettingStore";

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

afterEach(() => {
  delete (globalThis as { chrome?: ChromeStub }).chrome;
});

describe("ChromeAutoSaveSettingStore", () => {
  it("defaults to disabled when chrome.storage is unavailable", async () => {
    const store = new ChromeAutoSaveSettingStore();
    await expect(store.isEnabled()).resolves.toBe(false);
  });

  it("defaults to disabled when no value is stored", async () => {
    installChrome({
      storage: { local: { get: async () => ({}), set: async () => {} } },
    });
    const store = new ChromeAutoSaveSettingStore();
    await expect(store.isEnabled()).resolves.toBe(false);
  });

  it("returns true only for a stored true", async () => {
    installChrome({
      storage: {
        local: { get: async () => ({ autosave_enabled: true }), set: async () => {} },
      },
    });
    const store = new ChromeAutoSaveSettingStore();
    await expect(store.isEnabled()).resolves.toBe(true);
  });

  it("persists the flag via setEnabled", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    installChrome({ storage: { local: { get: async () => ({}), set } } });
    const store = new ChromeAutoSaveSettingStore();

    await store.setEnabled(true);

    expect(set).toHaveBeenCalledWith({ autosave_enabled: true });
  });
});
