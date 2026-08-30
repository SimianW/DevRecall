import type { PersistentStorageState } from "../../shared/messages";

export type PersistentStoragePort = {
  request(): Promise<PersistentStorageState>;
  getState(): Promise<PersistentStorageState>;
};

type StorageManagerPort = Pick<StorageManager, "persist" | "persisted">;

export function createPersistentStoragePort(
  storage: StorageManagerPort | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.storage,
): PersistentStoragePort {
  return {
    async request() {
      if (!storage) return "unknown";
      try {
        if (await storage.persisted()) return "granted";
        return (await storage.persist()) ? "granted" : "denied";
      } catch {
        return "unknown";
      }
    },

    async getState() {
      if (!storage) return "unknown";
      try {
        return (await storage.persisted()) ? "granted" : "denied";
      } catch {
        return "unknown";
      }
    },
  };
}
