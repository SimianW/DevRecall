import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
  type WorkerBroadcast,
} from "../shared/messages";
import type { PageHit, PageListItem, PageRecord } from "../shared/types";
import { normalizeUrl } from "../lib/urlNormalize";
import { OpenAIProvider, testOpenAIConnection } from "./llm/OpenAIProvider";
import { ChunkRepo } from "./repository/ChunkRepo";
import { PageRepo, toPageListItem } from "./repository/PageRepo";
import { CaptureService } from "./services/CaptureService";
import {
  AutoSaveService,
  chromeAlarmPort,
  chromeSessionPort,
  chromeTabPort,
} from "./services/AutoSaveService";
import { RetrievalService } from "./services/RetrievalService";
import { ChromeApiKeyStore, type ApiKeyStore } from "./settings/ApiKeyStore";

type CapturePort = {
  save(tabId: number, saveMode?: "manual" | "auto"): Promise<PageRecord>;
  processPage(pageId: string, apiKey: string): Promise<PageRecord>;
  reindexPages(
    pageIds: string[],
    apiKey: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<void>;
};

type PageListPort = {
  listPages(input: { limit: number }): Promise<PageListItem[]>;
  getStats(): Promise<{
    pageCount: number;
    totalTextBytes: number;
    pagesMissingEmbeddings: number;
  }>;
  getByUrlHash(urlHash: string): Promise<PageRecord | undefined>;
  deleteWithChunks(id: string): Promise<void>;
  pageIdsMissingEmbeddings(): Promise<string[]>;
};

type SearchPort = {
  search(
    query: string,
    options?: { topK?: number; apiKey?: string | null },
  ): Promise<PageHit[]>;
  invalidate(): void;
};

type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
  apiKeyStore: ApiKeyStore;
  testConnection: (apiKey: string) => Promise<{ success: boolean; message: string }>;
  retrievalService: SearchPort;
  broadcast: (message: WorkerBroadcast) => void;
};

function broadcast(message: WorkerBroadcast): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return;
  }
  // Fire-and-forget. With no open receiver, Chrome rejects with
  // "Receiving end does not exist" — harmless here, so swallow it.
  void chrome.runtime.sendMessage(message).catch(() => {});
}

const pageRepo = new PageRepo();
const chunkRepo = new ChunkRepo();
const openai = new OpenAIProvider();
const captureService = new CaptureService(pageRepo, undefined, pageRepo, openai, chunkRepo, openai);
const defaultDeps: HandlerDeps = {
  captureService,
  pageRepo,
  apiKeyStore: new ChromeApiKeyStore(),
  testConnection: testOpenAIConnection,
  retrievalService: new RetrievalService(chunkRepo, pageRepo, openai),
  broadcast,
};

// ---------------------------------------------------------------------------
// Auto-save: alarm-driven dwell timer for allowlisted domains.
// MV3 note: the service worker is killed after ~30 s of inactivity.
// Listeners MUST be registered at the top level so they fire on every worker wake.
// ---------------------------------------------------------------------------
const autoSaveService = new AutoSaveService(
  chromeAlarmPort,
  chromeSessionPort,
  chromeTabPort,
  {
    saveAuto: async (tabId: number) => {
      const page = await captureService.save(tabId, "auto");
      const apiKey = await defaultDeps.apiKeyStore.getApiKey();
      defaultDeps.retrievalService.invalidate();
      broadcast({ type: "page.updated", payload: { page: toPageListItem(page) } });
      if (apiKey) {
        void captureService
          .processPage(page.id, apiKey)
          .then((processed) => {
            defaultDeps.retrievalService.invalidate();
            broadcast({ type: "page.updated", payload: { page: toPageListItem(processed) } });
          })
          .catch((err) => {
            console.error("[DevRecall] auto-save LLM processing error:", err);
          });
      }
      return page;
    },
  },
  {
    getByUrlHash: (urlHash: string) => pageRepo.getByUrlHash(urlHash),
  },
);

export async function handleRequest(
  request: DevRecallRequest,
  deps: HandlerDeps = defaultDeps,
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

      const apiKey = await deps.apiKeyStore.getApiKey();
      if (apiKey) {
        void deps.captureService
          .processPage(page.id, apiKey)
          .then((processed) => {
            deps.retrievalService.invalidate();
            deps.broadcast({
              type: "page.updated",
              payload: { page: toPageListItem(processed) },
            });
          })
          .catch((error) => {
            console.error("[DevRecall] LLM processing error:", error);
          });
      }

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
  deps: HandlerDeps = defaultDeps,
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

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    console.info("[DevRecall] installed");
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (request: DevRecallRequest, _sender, sendResponse: (response: DevRecallResponse) => void) => {
      void handleMessage(request, sendResponse);
      return true;
    },
  );
}

if (typeof chrome !== "undefined" && chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "open-side-panel" && chrome.sidePanel?.open) {
      // Synchronous within the command gesture — no await before open().
      void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    }
  });
}

// ---------------------------------------------------------------------------
// Auto-save listeners — registered at the TOP LEVEL so they survive worker
// restarts (MV3: the worker re-runs top-level code on every wake event).
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.alarms?.onAlarm) {
  // chrome.alarms minimum granularity is 30 s on Chrome 120+.
  chrome.alarms.onAlarm.addListener((alarm) => {
    void autoSaveService.onAlarmFired(alarm.name);
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    void autoSaveService.onTabActivated(activeInfo.tabId);
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status && tab.url) {
      void autoSaveService.onTabUpdated(tabId, changeInfo.status, tab.url);
    }
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void autoSaveService.onTabRemoved(tabId);
  });
}
