import { normalizeUrl } from "../lib/urlNormalize";
import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
  type PageListItemWithExcerpt,
  type WorkerBroadcast,
} from "../shared/messages";
import type { EffectiveMode } from "../shared/modes";
import type { PageRecord } from "../shared/types";
import { toPageListItem, toPageListItemWithExcerpt } from "./repository/PageRepo";
import type { SearchInput, SearchOutcome } from "./services/RetrievalService";
import type { BulkTaskProgress, BulkTaskRunnerPort } from "./services/BulkTaskRunner";
import type { ApiKeyStore } from "./settings/ApiKeyStore";
import type { AutoSaveSettingStore } from "./settings/AutoSaveSettingStore";
import type { ModeStore } from "./settings/ModeStore";

export type CapturePort = {
  save(tabId: number, saveMode?: "manual" | "auto"): Promise<PageRecord>;
  retryLocalPage(pageId: string): Promise<PageRecord>;
  processPage(pageId: string, apiKey: string): Promise<PageRecord>;
  reindexSemanticPage(pageId: string, apiKey: string): Promise<PageRecord>;
  recoverStaleEnriching(): Promise<number>;
};

export type PageListPort = {
  listPages(input: { limit: number }): Promise<PageListItemWithExcerpt[]>;
  getStats(): Promise<{
    pageCount: number;
    totalTextBytes: number;
    pagesMissingEmbeddings: number;
  }>;
  getById(id: string): Promise<PageRecord | undefined>;
  getByUrlHash(urlHash: string): Promise<PageRecord | undefined>;
  deleteWithChunks(id: string): Promise<void>;
  pageIdsKeywordReady(): Promise<string[]>;
  pageIdsNeedingSemanticIndex(embeddingModel: string, indexVersion: number): Promise<string[]>;
  exportAll(): Promise<PageRecord[]>;
  deleteAll(): Promise<void>;
};

export type SearchPort = {
  search(input: SearchInput): Promise<SearchOutcome>;
  invalidate(): void;
};

export type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
  apiKeyStore: ApiKeyStore;
  modeStore: ModeStore;
  testConnection: (apiKey: string) => Promise<{ success: boolean; message: string }>;
  retrievalService: SearchPort;
  bulkRunner: BulkTaskRunnerPort;
  semanticIndex: { embeddingModel: string; indexVersion: number };
  broadcast: (message: WorkerBroadcast) => void;
  autoSaveSettings: AutoSaveSettingStore;
};

const automaticPrivacyRevision = new WeakMap<HandlerDeps, number>();
const bulkConsentRevision = new WeakMap<HandlerDeps, number>();
const explicitPages = new WeakMap<HandlerDeps, Set<string>>();

function revisionFor(revisions: WeakMap<HandlerDeps, number>, deps: HandlerDeps): number {
  return revisions.get(deps) ?? 0;
}

function incrementRevision(revisions: WeakMap<HandlerDeps, number>, deps: HandlerDeps): void {
  revisions.set(deps, revisionFor(revisions, deps) + 1);
}

function revokeAutomaticAndBulkWork(deps: HandlerDeps): void {
  incrementRevision(automaticPrivacyRevision, deps);
  incrementRevision(bulkConsentRevision, deps);
  deps.bulkRunner.cancel();
}

function revokeBulkConsent(deps: HandlerDeps): void {
  incrementRevision(bulkConsentRevision, deps);
  deps.bulkRunner.cancel();
}

function usableApiKey(apiKey: string | null): apiKey is string {
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

async function currentMode(deps: HandlerDeps): Promise<{
  apiKey: string | null;
  hasApiKey: boolean;
  effectiveMode: EffectiveMode;
}> {
  const apiKey = await deps.apiKeyStore.getApiKey();
  const hasApiKey = usableApiKey(apiKey);
  return {
    apiKey: hasApiKey ? apiKey : null,
    hasApiKey,
    effectiveMode: await deps.modeStore.getEffectiveMode(hasApiKey),
  };
}

function broadcastPage(deps: HandlerDeps, page: PageRecord): void {
  deps.retrievalService.invalidate();
  deps.broadcast({ type: "page.updated", payload: { page: toPageListItemWithExcerpt(page) } });
}

/** Automatic enrichment obeys the latest effective mode. */
export function processPageInBackground(deps: HandlerDeps, pageId: string): void {
  const privacyRevision = revisionFor(automaticPrivacyRevision, deps);
  void (async () => {
    const { apiKey, effectiveMode } = await currentMode(deps);
    if (
      privacyRevision !== revisionFor(automaticPrivacyRevision, deps) ||
      effectiveMode !== "hybrid" ||
      !apiKey
    ) {
      return;
    }
    const processed = await deps.captureService.processPage(pageId, apiKey);
    broadcastPage(deps, processed);
  })().catch((error) => {
    console.error("[DevRecall] background processing error:", error);
  });
}

export async function recoverStaleEnriching(deps: HandlerDeps): Promise<number> {
  return deps.captureService.recoverStaleEnriching();
}

/** Explicit per-page consent may run while Local-only is selected. */
function processExplicitPageInBackground(deps: HandlerDeps, pageId: string, apiKey: string): void {
  const activePages = explicitPages.get(deps) ?? new Set<string>();
  activePages.add(pageId);
  explicitPages.set(deps, activePages);

  void deps.captureService
    .processPage(pageId, apiKey)
    .then((processed) => broadcastPage(deps, processed))
    .catch((error) => {
      console.error("[DevRecall] explicit enrichment error:", error);
    })
    .finally(() => {
      activePages.delete(pageId);
    });
}

function isExplicitPageActive(deps: HandlerDeps, pageId: string): boolean {
  return explicitPages.get(deps)?.has(pageId) ?? false;
}

function emitBulkProgress(deps: HandlerDeps, progress: BulkTaskProgress): void {
  deps.broadcast({ type: "bulk.progress", payload: progress });
}

function startBulkOperation(
  deps: HandlerDeps,
  kind: "enrich" | "semantic",
  pageIds: string[],
): void {
  const consentRevision = revisionFor(bulkConsentRevision, deps);
  let approvedApiKey: string | null = null;

  deps.bulkRunner.begin({
    kind,
    pageIds,
    shouldContinue: async () => {
      const apiKey = await deps.apiKeyStore.getApiKey();
      const consentStillCurrent = consentRevision === revisionFor(bulkConsentRevision, deps);
      approvedApiKey = consentStillCurrent && usableApiKey(apiKey) ? apiKey : null;
      return approvedApiKey !== null;
    },
    runPage: async (pageId) => {
      const apiKey = approvedApiKey;
      approvedApiKey = null;
      if (!apiKey) {
        throw new Error("Bulk consent expired");
      }

      const processed =
        kind === "enrich"
          ? await deps.captureService.processPage(pageId, apiKey)
          : await deps.captureService.reindexSemanticPage(pageId, apiKey);
      broadcastPage(deps, processed);

      if (kind === "enrich" && processed.status !== "ready") {
        throw new Error(processed.enrichmentError ?? `Could not enrich page ${pageId}`);
      }
    },
    onProgress: (progress) => emitBulkProgress(deps, progress),
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
        payload: { appName: APP_NAME, version: APP_VERSION },
      };

    case "settings.getStatus": {
      const mode = await currentMode(deps);
      return {
        type: "settings.status",
        payload: {
          hasApiKey: mode.hasApiKey,
          persistentStorage: "unknown",
          storedMode: await deps.modeStore.getStoredMode(),
          effectiveMode: mode.effectiveMode,
        },
      };
    }

    case "settings.setApiKey": {
      if (!usableApiKey(request.payload.apiKey)) {
        revokeAutomaticAndBulkWork(deps);
      }
      await deps.apiKeyStore.setApiKey(request.payload.apiKey);
      const { hasApiKey, effectiveMode } = await currentMode(deps);
      deps.broadcast({
        type: "settings.changed",
        payload: {
          hasApiKey,
          storedMode: await deps.modeStore.getStoredMode(),
          effectiveMode,
        },
      });
      return { type: "settings.apiKeySet" };
    }

    case "settings.testConnection": {
      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!usableApiKey(apiKey)) {
        return {
          type: "settings.connectionTestResult",
          payload: { success: false, message: "No API key set" },
        };
      }
      return { type: "settings.connectionTestResult", payload: await deps.testConnection(apiKey) };
    }

    case "settings.getMode": {
      const { effectiveMode } = await currentMode(deps);
      return {
        type: "settings.mode",
        payload: { storedMode: await deps.modeStore.getStoredMode(), effectiveMode },
      };
    }

    case "settings.setMode": {
      if (request.payload.mode === "local") {
        revokeAutomaticAndBulkWork(deps);
      }
      await deps.modeStore.setStoredMode(request.payload.mode);
      const apiKey = await deps.apiKeyStore.getApiKey();
      const hasApiKey = usableApiKey(apiKey);
      const effectiveMode = await deps.modeStore.getEffectiveMode(hasApiKey);
      deps.broadcast({
        type: "settings.changed",
        payload: {
          hasApiKey,
          storedMode: request.payload.mode,
          effectiveMode,
        },
      });
      return {
        type: "settings.modeSet",
        payload: {
          storedMode: request.payload.mode,
          effectiveMode,
        },
      };
    }

    case "page.save": {
      const page = await deps.captureService.save(request.payload.tabId);
      broadcastPage(deps, page);
      processPageInBackground(deps, page.id);
      return { type: "page.saved", payload: { page: toPageListItem(page) } };
    }

    case "page.list":
      return {
        type: "page.listed",
        payload: { pages: await deps.pageRepo.listPages({ limit: request.payload.limit }) },
      };

    case "storage.getStats": {
      const [stats, candidates] = await Promise.all([
        deps.pageRepo.getStats(),
        deps.pageRepo.pageIdsNeedingSemanticIndex(
          deps.semanticIndex.embeddingModel,
          deps.semanticIndex.indexVersion,
        ),
      ]);
      return {
        type: "storage.stats",
        payload: { ...stats, pagesMissingEmbeddings: candidates.length },
      };
    }

    case "page.statusForUrl": {
      const { urlHash } = await normalizeUrl(request.payload.url);
      const page = await deps.pageRepo.getByUrlHash(urlHash);
      if (!page || page.status === "failed") {
        return { type: "page.urlStatus", payload: { saved: false } };
      }
      return {
        type: "page.urlStatus",
        payload: {
          saved: true,
          status: page.status,
          savedAt: page.savedAt,
          ...(page.enrichmentError ? { enrichmentError: page.enrichmentError } : {}),
        },
      };
    }

    case "search.run": {
      const { effectiveMode } = await currentMode(deps);
      const outcome = await deps.retrievalService.search({
        query: request.payload.query,
        topK: request.payload.topK,
        effectiveMode,
      });
      return { type: "search.results", payload: outcome };
    }

    case "page.delete":
      await deps.pageRepo.deleteWithChunks(request.payload.id);
      deps.retrievalService.invalidate();
      deps.broadcast({ type: "page.removed", payload: { id: request.payload.id } });
      return { type: "page.deleted", payload: { id: request.payload.id } };

    case "page.retry":
    case "page.addAiFeatures": {
      const pageId = request.type === "page.retry" ? request.payload.id : request.payload.pageId;
      const page = await deps.pageRepo.getById(pageId);
      if (!page) {
        return { type: "error", payload: { message: `Page ${pageId} not found` } };
      }

      if (request.type === "page.retry" && page.status === "failed") {
        const retried = await deps.captureService.retryLocalPage(pageId);
        broadcastPage(deps, retried);
        processPageInBackground(deps, pageId);
        return { type: "page.retryStarted", payload: { page: toPageListItem(retried) } };
      }

      if (page.status !== "keyword_ready") {
        return {
          type: "error",
          payload: { message: `Page ${pageId} is not eligible for AI features` },
        };
      }
      if (request.type === "page.retry" && !page.enrichmentError) {
        return {
          type: "error",
          payload: { message: `Page ${pageId} has no AI enrichment error to retry` },
        };
      }
      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!usableApiKey(apiKey)) {
        return { type: "error", payload: { message: "No API key set" } };
      }
      if (isExplicitPageActive(deps, pageId)) {
        return {
          type: "error",
          payload: { message: `AI features are already being added to page ${pageId}` },
        };
      }

      processExplicitPageInBackground(deps, pageId, apiKey);
      const enriching = toPageListItem({
        ...page,
        status: "enriching",
        enrichmentError: undefined,
      });
      deps.broadcast({
        type: "page.updated",
        payload: { page: { ...enriching, excerpt: toPageListItemWithExcerpt(page).excerpt } },
      });
      return request.type === "page.retry"
        ? { type: "page.retryStarted", payload: { page: enriching } }
        : { type: "page.aiFeaturesStarted", payload: { page: enriching } };
    }

    case "library.bulkEnrich": {
      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!usableApiKey(apiKey)) {
        return { type: "error", payload: { message: "No API key set" } };
      }
      const pageIds = await deps.pageRepo.pageIdsKeywordReady();
      startBulkOperation(deps, "enrich", pageIds);
      return { type: "library.bulkEnrichStarted", payload: { total: pageIds.length } };
    }

    case "library.reindexSemantic": {
      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!usableApiKey(apiKey)) {
        return { type: "error", payload: { message: "No API key set" } };
      }
      const pageIds = await deps.pageRepo.pageIdsNeedingSemanticIndex(
        deps.semanticIndex.embeddingModel,
        deps.semanticIndex.indexVersion,
      );
      startBulkOperation(deps, "semantic", pageIds);
      return { type: "library.reindexSemanticStarted", payload: { total: pageIds.length } };
    }

    case "library.cancelBulk":
      revokeBulkConsent(deps);
      return { type: "library.bulkCanceled" };

    case "library.reindex":
      return {
        type: "error",
        payload: { message: "Confirm Re-index semantic search before starting this operation" },
      };

    case "data.export": {
      const pages = await deps.pageRepo.exportAll();
      return {
        type: "data.exported",
        payload: { json: JSON.stringify({ schemaVersion: 1, pages }, null, 2) },
      };
    }

    case "data.deleteAll":
      await deps.pageRepo.deleteAll();
      deps.retrievalService.invalidate();
      deps.broadcast({ type: "library.cleared" });
      return { type: "data.deletedAll" };

    case "settings.getAutoSave":
      return {
        type: "settings.autoSave",
        payload: { enabled: await deps.autoSaveSettings.isEnabled() },
      };

    case "settings.setAutoSave":
      await deps.autoSaveSettings.setEnabled(request.payload.enabled);
      return { type: "settings.autoSaveSet", payload: { enabled: request.payload.enabled } };

    default:
      throw new Error(`Unhandled request type: ${(request as { type: string }).type}`);
  }
}

export async function handleMessage(
  request: DevRecallRequest,
  sendResponse: (response: DevRecallResponse) => void,
  deps: HandlerDeps,
): Promise<void> {
  try {
    sendResponse(await handleRequest(request, deps));
  } catch (error) {
    console.error("[DevRecall] handler error:", error);
    sendResponse({
      type: "error",
      payload: { message: error instanceof Error ? error.message : "Unknown error" },
    });
  }
}
