export type AutoSaveSettingStore = {
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
};

const STORAGE_KEY = "autosave_enabled";

/**
 * Auto-save opt-in flag in chrome.storage.local. Defaults to false (off):
 * silently capturing browsing history must be an explicit user choice.
 * Read failures also resolve to false — the safe direction.
 */
export class ChromeAutoSaveSettingStore implements AutoSaveSettingStore {
  async isEnabled(): Promise<boolean> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return false;
    }

    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] === true;
    } catch {
      return false;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      throw new Error("Chrome storage is unavailable");
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  }
}
