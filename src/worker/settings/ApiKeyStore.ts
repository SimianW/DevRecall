export type ApiKeyStore = {
  getApiKey(): Promise<string | null>;
  setApiKey(apiKey: string): Promise<void>;
};

const STORAGE_KEY = "openai_api_key";

export class ChromeApiKeyStore implements ApiKeyStore {
  async getApiKey(): Promise<string | null> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return null;
    }

    const result = await chrome.storage.local.get(STORAGE_KEY);

    return (result[STORAGE_KEY] as string) ?? null;
  }

  async setApiKey(apiKey: string): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      throw new Error("Chrome storage is unavailable");
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: apiKey });
  }
}
