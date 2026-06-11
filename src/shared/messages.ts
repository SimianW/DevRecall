import type { ExtractedPage, PageHit, PageListItem, PageStatus } from "./types";

export const APP_NAME = "DevRecall";
export const APP_VERSION = "0.5.7.6";

export type PersistentStorageState = "unknown" | "granted" | "denied";

export type DevRecallRequest =
  | { type: "devrecall.ping" }
  | { type: "settings.getStatus" }
  | { type: "settings.setApiKey"; payload: { apiKey: string } }
  | { type: "settings.testConnection" }
  | { type: "page.save"; payload: { tabId: number } }
  | { type: "page.list"; payload: { limit: number } }
  | { type: "storage.getStats" }
  | { type: "page.statusForUrl"; payload: { url: string } }
  | { type: "search.run"; payload: { query: string; topK?: number } }
  | { type: "page.delete"; payload: { id: string } }
  | { type: "page.retry"; payload: { id: string } }
  | { type: "library.reindex" }
  | { type: "data.export" }
  | { type: "data.deleteAll" }
  | { type: "settings.getAutoSave" }
  | { type: "settings.setAutoSave"; payload: { enabled: boolean } };

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
    }
  | {
      type: "storage.stats";
      payload: {
        pageCount: number;
        totalTextBytes: number;
        pagesMissingEmbeddings: number;
      };
    }
  | {
      type: "page.urlStatus";
      payload:
        | { saved: false }
        | {
            saved: true;
            status: PageStatus;
            savedAt: number;
            errorReason?: string;
          };
    }
  | {
      type: "search.results";
      payload: {
        hits: PageHit[];
      };
    }
  | { type: "page.deleted"; payload: { id: string } }
  | { type: "page.retryStarted"; payload: { page: PageListItem } }
  | { type: "library.reindexStarted"; payload: { total: number } }
  | { type: "data.exported"; payload: { json: string } }
  | { type: "data.deletedAll" }
  | { type: "settings.autoSave"; payload: { enabled: boolean } }
  | { type: "settings.autoSaveSet"; payload: { enabled: boolean } }
  | {
      type: "error";
      payload: {
        message: string;
      };
    };

export type WorkerBroadcast =
  | { type: "page.updated"; payload: { page: PageListItem } }
  | { type: "page.removed"; payload: { id: string } }
  | { type: "library.cleared" }
  | { type: "library.reindexProgress"; payload: { done: number; total: number } };

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
