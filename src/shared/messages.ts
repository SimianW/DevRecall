import type { ExtractedPage, PageListItem } from "./types";

export const APP_NAME = "DevRecall";
export const APP_VERSION = "0.1.0";

export type PersistentStorageState = "unknown" | "granted" | "denied";

export type DevRecallRequest =
  | { type: "devrecall.ping" }
  | { type: "settings.getStatus" }
  | { type: "settings.setApiKey"; payload: { apiKey: string } }
  | { type: "settings.testConnection" }
  | { type: "page.save"; payload: { tabId: number } }
  | { type: "page.list"; payload: { limit: number } };

export type DevRecallResponse =
  | {
      type: "devrecall.pong";
      payload: {
        appName: typeof APP_NAME;
        version: typeof APP_VERSION;
      };
    }
  | {
      type: "settings.status";
      payload: {
        hasApiKey: boolean;
        persistentStorage: PersistentStorageState;
      };
    }
  | { type: "settings.apiKeySet" }
  | {
      type: "settings.connectionTestResult";
      payload: {
        success: boolean;
        message: string;
      };
    }
  | {
      type: "page.saved";
      payload: {
        page: PageListItem;
      };
    }
  | {
      type: "page.listed";
      payload: {
        pages: PageListItem[];
      };
    };

export type ContentExtractRequest = { type: "content.extract" };

export type ContentExtractResponse =
  | {
      type: "content.extracted";
      payload: ExtractedPage;
    }
  | {
      type: "content.extractFailed";
      payload: {
        message: string;
      };
    };
