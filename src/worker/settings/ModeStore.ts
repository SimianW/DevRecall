import type { EffectiveMode, StoredMode } from "../../shared/modes";

export type { EffectiveMode, SearchMode, StoredMode } from "../../shared/modes";

export type ModeStore = {
  getStoredMode(): Promise<StoredMode>;
  setStoredMode(mode: StoredMode): Promise<void>;
  getEffectiveMode(hasApiKey: boolean): Promise<EffectiveMode>;
  getDefaultEffectiveMode(hasApiKey: boolean): EffectiveMode;
};

const STORAGE_KEY = "search_mode";

/** Hybrid is the preferred experience; it degrades gracefully when no key exists. */
export const DEFAULT_STORED_MODE: StoredMode = "hybrid";

const STORED_MODE_VALUES: readonly string[] = ["local", "hybrid"];

/** Type guard: true when `value` is a valid StoredMode (e.g. validating storage or RPC input). */
export function isStoredMode(value: unknown): value is StoredMode {
  return typeof value === "string" && STORED_MODE_VALUES.includes(value);
}

/**
 * Resolve a stored user choice against API key availability.
 *
 * "local" never needs a key, so it is always honored as-is. "hybrid" needs an
 * embedding API key. Without one, the effective application mode is Local.
 * The stored Hybrid preference remains unchanged and becomes effective again
 * after the user adds a usable key.
 */
export function computeEffectiveMode(storedMode: StoredMode, hasApiKey: boolean): EffectiveMode {
  return storedMode === "hybrid" && hasApiKey ? "hybrid" : "local";
}

/**
 * Search-mode preference in chrome.storage.local.
 *
 * Separates what the user chose (StoredMode) from what the app can run
 * (EffectiveMode). The stored value is only ever "local" or "hybrid"; the
 * effective mode is always computed, never persisted, so adding or revoking an
 * API key takes effect on the very next operation. A missing key resolves a
 * stored Hybrid preference to Local without changing the preference.
 *
 * Read failures and invalid stored values resolve to the default "hybrid" —
 * a corrupt row must not lock the user out of their chosen experience.
 */
export class ChromeModeStore implements ModeStore {
  async getStoredMode(): Promise<StoredMode> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return DEFAULT_STORED_MODE;
    }

    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const value = result[STORAGE_KEY];
      return isStoredMode(value) ? value : DEFAULT_STORED_MODE;
    } catch {
      return DEFAULT_STORED_MODE;
    }
  }

  async setStoredMode(mode: StoredMode): Promise<void> {
    if (!isStoredMode(mode)) {
      throw new Error("Invalid stored mode");
    }

    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      throw new Error("Chrome storage is unavailable");
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: mode });
  }

  async getEffectiveMode(hasApiKey: boolean): Promise<EffectiveMode> {
    const storedMode = await this.getStoredMode();
    return computeEffectiveMode(storedMode, hasApiKey);
  }

  getDefaultEffectiveMode(hasApiKey: boolean): EffectiveMode {
    return computeEffectiveMode(DEFAULT_STORED_MODE, hasApiKey);
  }
}
