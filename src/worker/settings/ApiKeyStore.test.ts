import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChromeApiKeyStore } from "./ApiKeyStore";

describe("ChromeApiKeyStore", () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGet = vi.fn();
    mockSet = vi.fn().mockResolvedValue(undefined);
    globalThis.chrome = {
      storage: { local: { get: mockGet, set: mockSet } },
    } as unknown as typeof chrome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no API key is stored", async () => {
    mockGet.mockResolvedValue({});

    const store = new ChromeApiKeyStore();

    await expect(store.getApiKey()).resolves.toBeNull();
    expect(mockGet).toHaveBeenCalledWith("openai_api_key");
  });

  it("returns the stored API key", async () => {
    mockGet.mockResolvedValue({ openai_api_key: "sk-test123" });

    const store = new ChromeApiKeyStore();

    await expect(store.getApiKey()).resolves.toBe("sk-test123");
  });

  it("stores an API key", async () => {
    const store = new ChromeApiKeyStore();

    await store.setApiKey("sk-new");

    expect(mockSet).toHaveBeenCalledWith({ openai_api_key: "sk-new" });
  });
});
