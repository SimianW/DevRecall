import type { EffectiveMode, SearchMode, StoredMode } from "./modes";
import type { ExtractedPage, PageHit, PageListItem, PageStatus } from "./types";

export const APP_NAME = "DevRecall";
export const APP_VERSION = "1.1.0.0";

export type PersistentStorageState = "unknown" | "granted" | "denied";

/**
 * A library-list item as sent to the UI: PageListItem plus a short excerpt
 * derived from `fullText` at query time. `fullText` itself never crosses the
 * RPC boundary.
 */
export type PageListItemWithExcerpt = PageListItem & { excerpt: string };

export type DevRecallRequest =
  | { type: "devrecall.ping" }
  | { type: "settings.getStatus" }
  | { type: "settings.setApiKey"; payload: { apiKey: string } }
  | { type: "settings.testConnection" }
  | { type: "settings.getMode" }
  | { type: "settings.setMode"; payload: { mode: StoredMode } }
  | { type: "page.save"; payload: { tabId: number } }
  | { type: "page.list"; payload: { limit: number } }
  | { type: "storage.getStats" }
  | { type: "page.statusForUrl"; payload: { url: string } }
  | { type: "search.run"; payload: { query: string; topK?: number } }
  | { type: "page.delete"; payload: { id: string } }
  | { type: "page.retry"; payload: { id: string } }
  | { type: "page.addAiFeatures"; payload: { pageId: string } }
  | { type: "library.reindex" }
  | { type: "library.prepareBulkEnrich"; payload: Record<string, never> }
  | { type: "library.bulkEnrich"; payload: { batchId: string } }
  | { type: "library.prepareReindexSemantic"; payload: Record<string, never> }
  | { type: "library.reindexSemantic"; payload: { batchId: string } }
  | { type: "library.cancelBulk"; payload: Record<string, never> }
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
        storedMode: StoredMode;
        effectiveMode: EffectiveMode;
      };
    }
  | { type: "settings.apiKeySet" }
  | {
      type: "settings.mode";
      payload: {
        storedMode: StoredMode;
        effectiveMode: EffectiveMode;
      };
    }
  | {
      type: "settings.modeSet";
      payload: {
        storedMode: StoredMode;
        effectiveMode: EffectiveMode;
      };
    }
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
        pages: PageListItemWithExcerpt[];
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
            localSaveError?: string;
            enrichmentError?: string;
          };
    }
  | {
      type: "search.results";
      payload: {
        results: PageHit[];
        searchMode: SearchMode;
      };
    }
  | { type: "page.deleted"; payload: { id: string } }
  | { type: "page.retryStarted"; payload: { page: PageListItem } }
  | { type: "page.aiFeaturesStarted"; payload: { page: PageListItem } }
  | { type: "library.reindexStarted"; payload: { total: number } }
  | { type: "library.bulkEnrichPrepared"; payload: { batchId: string; count: number } }
  | { type: "library.bulkEnrichStarted"; payload: { total: number } }
  | { type: "library.reindexSemanticPrepared"; payload: { batchId: string; count: number } }
  | { type: "library.reindexSemanticStarted"; payload: { total: number } }
  | { type: "library.bulkCanceled" }
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
  | { type: "page.updated"; payload: { page: PageListItem & { excerpt?: string } } }
  | { type: "page.removed"; payload: { id: string } }
  | { type: "library.cleared" }
  | { type: "library.reindexProgress"; payload: { done: number; total: number } }
  | {
      type: "bulk.progress";
      payload: {
        kind: "enrich" | "semantic";
        done: number;
        total: number;
        failed: number;
        remaining: number;
        currentPageId?: string;
        canceled?: boolean;
      };
    }
  | {
      type: "settings.changed";
      payload: {
        hasApiKey: boolean;
        storedMode: StoredMode;
        effectiveMode: EffectiveMode;
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
