import { describe, expect, it, vi } from "vitest";

import { createPersistentStoragePort } from "./PersistentStorage";

describe("persistent storage", () => {
  it("requests persistence when it has not already been granted", async () => {
    const storage = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(true),
    };

    await expect(createPersistentStoragePort(storage).request()).resolves.toBe("granted");
    expect(storage.persist).toHaveBeenCalledOnce();
  });

  it("reports denied persistence without requesting it during a status read", async () => {
    const storage = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn(),
    };

    await expect(createPersistentStoragePort(storage).getState()).resolves.toBe("denied");
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it("reports unknown when the browser API is unavailable or fails", async () => {
    await expect(createPersistentStoragePort(undefined).getState()).resolves.toBe("unknown");
    await expect(
      createPersistentStoragePort({
        persisted: vi.fn().mockRejectedValue(new Error("unavailable")),
        persist: vi.fn(),
      }).getState(),
    ).resolves.toBe("unknown");
  });
});
