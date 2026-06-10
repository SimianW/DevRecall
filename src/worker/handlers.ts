import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
  type WorkerBroadcast,
} from "../shared/messages";
import type { PageHit, PageListItem, PageRecord } from "../shared/types";
import { normalizeUrl } from "../lib/urlNormalize";
import { toPageListItem } from "./repository/PageRepo";
import type { ApiKeyStore } from "./settings/ApiKeyStore";

export type CapturePort = {
  save(tabId: number, saveMode?: "manual" | "auto"): Promise<PageRecord>;
  processPage(pageId: string, apiKey: string): Promise<PageRecord>;
  reindexPages(
    pageIds: string[],
    apiKey: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<void>;
};

export type PageListPort = {
  listPages(input: { limit: number }): Promise<PageListItem[]>;
  getStats(): Promise<{
    pageCount: number;
    totalTextBytes: number;
    pagesMissingEmbeddings: number;
  }>;
  getById(id: string): Promise<PageRecord | undefined>;
  getByUrlHash(urlHash: string): Promise<PageRecord | undefined>;
  updatePage(id: string, data: Partial<Omit<PageRecord, "id" | "schemaVersion">>): Promise<void>;
  deleteWithChunks(id: string): Promise<void>;
  pageIdsMissingEmbeddings(): Promise<string[]>;
  exportAll(): Promise<PageRecord[]>;
  deleteAll(): Promise<void>;
};

export type SearchPort = {
  search(
    query: string,
    options?: { topK?: number; apiKey?: string | null },
  ): Promise<PageHit[]>;
  invalidate(): void;
};

export type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
  apiKeyStore: ApiKeyStore;
  testConnection: (apiKey: string) => Promise<{ success: boolean; message: string }>;
  retrievalService: SearchPort;
  broadcast: (message: WorkerBroadcast) => void;
};

/**
 * Fire-and-forget LLM processing for a captured page: looks up the API key,
 * runs processPage, then invalidates the retrieval cache and broadcasts the
 * updated record. No-op when no API key is set. Errors are logged, never thrown.
 */
export function processPageInBackground(deps: HandlerDeps, pageId: string): void {
  void (async () => {
    const apiKey = await deps.apiKeyStore.getApiKey();
    if (!apiKey) {
      return;
    }
    const processed = await deps.captureService.processPage(pageId, apiKey);
    deps.retrievalService.invalidate();
    deps.broadcast({ type: "page.updated", payload: { page: toPageListItem(processed) } });
  })().catch((error) => {
    console.error("[DevRecall] background processing error:", error);
  });
}

export async function handleRequest(
  request: DevRecallRequest,
  deps: HandlerDeps,
): Promise<DevRecallResponse> {
  switch (request.type) {
    case "devrecall.ping":
      return {
        type: "devrecall.pong",
        payload: {
          appName: APP_NAME,
          version: APP_VERSION,
        },
      };

    case "settings.getStatus": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      return {
        type: "settings.status",
        payload: {
          hasApiKey: apiKey !== null,
          persistentStorage: "unknown",
        },
      };
    }

    case "settings.setApiKey": {
      await deps.apiKeyStore.setApiKey(request.payload.apiKey);

      return { type: "settings.apiKeySet" };
    }

    case "settings.testConnection": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      if (!apiKey) {
        return {
          type: "settings.connectionTestResult",
          payload: { success: false, message: "No API key set" },
        };
      }

      const result = await deps.testConnection(apiKey);

      return {
        type: "settings.connectionTestResult",
        payload: result,
      };
    }

    case "page.save": {
      const page = await deps.captureService.save(request.payload.tabId);
      const listItem = toPageListItem(page);

      deps.retrievalService.invalidate();
      deps.broadcast({ type: "page.updated", payload: { page: listItem } });

      processPageInBackground(deps, page.id);

      return { type: "page.saved", payload: { page: listItem } };
    }

    case "page.list":
      return {
        type: "page.listed",
        payload: {
          pages: await deps.pageRepo.listPages({
            limit: request.payload.limit,
          }),
        },
      };

    case "storage.getStats": {
      const stats = await deps.pageRepo.getStats();
      return {
        type: "storage.stats",
        payload: stats,
      };
    }

    case "page.statusForUrl": {
      const { urlHash } = await normalizeUrl(request.payload.url);
      const page = await deps.pageRepo.getByUrlHash(urlHash);

      if (!page) {
        return { type: "page.urlStatus", payload: { saved: false } };
      }

      return {
        type: "page.urlStatus",
        payload: {
          saved: true,
          status: page.status,
          savedAt: page.savedAt,
          ...(page.errorReason ? { errorReason: page.errorReason } : {}),
        },
      };
    }

    case "search.run": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      return {
        type: "search.results",
        payload: {
          hits: await deps.retrievalService.search(request.payload.query, {
            topK: request.payload.topK,
            apiKey,
          }),
        },
      };
    }

    case "page.delete": {
      await deps.pageRepo.deleteWithChunks(request.payload.id);
      deps.retrievalService.invalidate();
      deps.broadcast({ type: "page.removed", payload: { id: request.payload.id } });

      return { type: "page.deleted", payload: { id: request.payload.id } };
    }

    case "page.retry": {
      const page = await deps.pageRepo.getById(request.payload.id);
      if (!page) {
        return { type: "error", payload: { message: `Page ${request.payload.id} not found` } };
      }
      if (page.status !== "failed") {
        return { type: "error", payload: { message: `Page ${request.payload.id} is not failed` } };
      }

      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!apiKey) {
        return { type: "error", payload: { message: "No API key set" } };
      }

      await deps.pageRepo.updatePage(page.id, {
        status: "pending",
        errorReason: undefined,
      });

      const pendingPage: PageRecord = { ...page, status: "pending", errorReason: undefined };
      const listItem = toPageListItem(pendingPage);
      deps.retrievalService.invalidate();
      deps.broadcast({ type: "page.updated", payload: { page: listItem } });

      processPageInBackground(deps, page.id);

      return { type: "page.retryStarted", payload: { page: listItem } };
    }

    case "data.export": {
      const pages = await deps.pageRepo.exportAll();
      const json = JSON.stringify({ schemaVersion: 1, pages }, null, 2);
      return { type: "data.exported", payload: { json } };
    }

    case "data.deleteAll": {
      await deps.pageRepo.deleteAll();
      deps.retrievalService.invalidate();
      deps.broadcast({ type: "library.cleared" });
      return { type: "data.deletedAll" };
    }

    case "library.reindex": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      if (!apiKey) {
        return { type: "error", payload: { message: "No API key set" } };
      }

      const pageIds = await deps.pageRepo.pageIdsMissingEmbeddings();

      void deps.captureService
        .reindexPages(pageIds, apiKey, (done, total) => {
          deps.retrievalService.invalidate();
          deps.broadcast({ type: "library.reindexProgress", payload: { done, total } });
        })
        .catch((error) => {
          console.error("[DevRecall] reindex error:", error);
        });

      return { type: "library.reindexStarted", payload: { total: pageIds.length } };
    }

    default:
      throw new Error(`Unhandled request type: ${(request as { type: string }).type}`);
  }
}

export async function handleMessage(
  request: DevRecallRequest,
  sendResponse: (response: DevRecallResponse) => void,
  deps: HandlerDeps,
): Promise<void> {
  let response: DevRecallResponse;

  try {
    response = await handleRequest(request, deps);
  } catch (error) {
    console.error("[DevRecall] handler error:", error);
    response = {
      type: "error",
      payload: {
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }

  sendResponse(response);
}
