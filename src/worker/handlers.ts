import { normalizeUrl } from "../lib/urlNormalize";
import { parseBackup, type BackupPage } from "../shared/backup";
import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
  type PageListItemWithExcerpt,
  type WorkerBroadcast,
} from "../shared/messages";
import type { EffectiveMode } from "../shared/modes";
import type { PageRecord, SearchFilter } from "../shared/types";
import { toPageListItem, toPageListItemWithExcerpt } from "./repository/PageRepo";
import type { SearchInput, SearchOutcome } from "./services/RetrievalService";
import type { BulkTaskProgress, BulkTaskRunnerPort } from "./services/BulkTaskRunner";
import type { ApiKeyStore } from "./settings/ApiKeyStore";
import type { AutoSaveSettingStore } from "./settings/AutoSaveSettingStore";
import type { ModeStore } from "./settings/ModeStore";
import type { PersistentStoragePort } from "./settings/PersistentStorage";

export type CapturePort = {
  save(
    tabId: number,
    saveMode?: "manual" | "auto",
    mayCommit?: () => Promise<boolean> | boolean,
  ): Promise<PageRecord>;
  retryLocalPage(pageId: string): Promise<PageRecord>;
  processPage(
    pageId: string,
    apiKey: string,
    mayProceed?: () => Promise<boolean> | boolean,
  ): Promise<PageRecord>;
  reindexSemanticPage(
    pageId: string,
    apiKey: string,
    mayProceed?: () => Promise<boolean> | boolean,
  ): Promise<PageRecord>;
  recoverStaleEnriching(): Promise<number>;
};

export type PageListPort = {
  listPages(input: {
    limit: number;
    offset?: number;
    filter?: SearchFilter;
  }): Promise<PageListItemWithExcerpt[]>;
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
  importPages(
    pages: BackupPage[],
    mayCommit?: () => Promise<boolean> | boolean,
  ): Promise<{ imported: number; skipped: number }>;
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
  persistentStorage: PersistentStoragePort;
};

const automaticPrivacyRevision = new WeakMap<HandlerDeps, number>();
const bulkConsentRevision = new WeakMap<HandlerDeps, number>();
const apiKeyRevision = new WeakMap<HandlerDeps, number>();
const explicitPages = new WeakMap<HandlerDeps, Set<string>>();
const pageOperationRevision = new WeakMap<HandlerDeps, Map<string, number>>();
const libraryOperationRevision = new WeakMap<HandlerDeps, number>();

type PageOperationToken = {
  pageId: string;
  pageRevision: number;
  libraryRevision: number;
  privacyRevision?: number;
  consentRevision?: number;
  apiKeyRevision?: number;
};
type PreparedBatchKind = "enrich" | "semantic";
type PreparedBatch = { kind: PreparedBatchKind; pageIds: string[] };
const preparedBatches = new WeakMap<HandlerDeps, Map<string, PreparedBatch>>();

function prepareBatch(
  deps: HandlerDeps,
  kind: PreparedBatchKind,
  pageIds: string[],
): { batchId: string; count: number } {
  const batches = preparedBatches.get(deps) ?? new Map<string, PreparedBatch>();
  for (const [batchId, batch] of batches) {
    if (batch.kind === kind) {
      batches.delete(batchId);
    }
  }
  const batchId = crypto.randomUUID();
  batches.set(batchId, { kind, pageIds: [...pageIds] });
  preparedBatches.set(deps, batches);
  return { batchId, count: pageIds.length };
}

function takePreparedBatch(
  deps: HandlerDeps,
  kind: PreparedBatchKind,
  batchId: string,
): string[] | null {
  const batches = preparedBatches.get(deps);
  const batch = batches?.get(batchId);
  if (!batch || batch.kind !== kind) {
    return null;
  }
  batches?.delete(batchId);
  return [...batch.pageIds];
}

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

function pageRevisionFor(deps: HandlerDeps, pageId: string): number {
  return pageOperationRevision.get(deps)?.get(pageId) ?? 0;
}

function incrementPageRevision(deps: HandlerDeps, pageId: string): void {
  const revisions = pageOperationRevision.get(deps) ?? new Map<string, number>();
  revisions.set(pageId, pageRevisionFor(deps, pageId) + 1);
  pageOperationRevision.set(deps, revisions);
}

function startPageOperation(
  deps: HandlerDeps,
  pageId: string,
  options: Pick<PageOperationToken, "privacyRevision" | "consentRevision" | "apiKeyRevision"> & {
    libraryRevision?: number;
  } = {},
): PageOperationToken {
  incrementPageRevision(deps, pageId);
  return {
    pageId,
    pageRevision: pageRevisionFor(deps, pageId),
    libraryRevision: options.libraryRevision ?? revisionFor(libraryOperationRevision, deps),
    ...(options.privacyRevision === undefined ? {} : { privacyRevision: options.privacyRevision }),
    ...(options.consentRevision === undefined ? {} : { consentRevision: options.consentRevision }),
    ...(options.apiKeyRevision === undefined ? {} : { apiKeyRevision: options.apiKeyRevision }),
  };
}

function isCurrentPageOperation(deps: HandlerDeps, token: PageOperationToken): boolean {
  return (
    token.pageRevision === pageRevisionFor(deps, token.pageId) &&
    token.libraryRevision === revisionFor(libraryOperationRevision, deps) &&
    (token.privacyRevision === undefined ||
      token.privacyRevision === revisionFor(automaticPrivacyRevision, deps)) &&
    (token.consentRevision === undefined ||
      token.consentRevision === revisionFor(bulkConsentRevision, deps)) &&
    (token.apiKeyRevision === undefined ||
      token.apiKeyRevision === revisionFor(apiKeyRevision, deps))
  );
}

function isCurrentLibraryOperation(deps: HandlerDeps, libraryRevision: number): boolean {
  return libraryRevision === revisionFor(libraryOperationRevision, deps);
}

async function mayProceedPageOperation(
  deps: HandlerDeps,
  token: PageOperationToken,
): Promise<boolean> {
  if (!isCurrentPageOperation(deps, token)) return false;
  const page = await deps.pageRepo.getById(token.pageId);
  const current = isCurrentPageOperation(deps, token);
  return page !== undefined && current;
}

async function broadcastCompletedPage(
  deps: HandlerDeps,
  token: PageOperationToken,
  page: PageRecord,
): Promise<void> {
  if (!isCurrentPageOperation(deps, token) || page.id !== token.pageId) return;
  const currentPage = await deps.pageRepo.getById(token.pageId);
  if (!currentPage || !isCurrentPageOperation(deps, token)) return;
  broadcastPage(deps, page);
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

export async function savePageInBackground(
  deps: HandlerDeps,
  tabId: number,
  saveMode: "manual" | "auto" = "manual",
): Promise<PageRecord> {
  const libraryRevision = revisionFor(libraryOperationRevision, deps);
  const page = await deps.captureService.save(tabId, saveMode, () =>
    isCurrentLibraryOperation(deps, libraryRevision),
  );
  if (isCurrentLibraryOperation(deps, libraryRevision)) {
    broadcastPage(deps, page);
    if (page.status === "keyword_ready") {
      processPageInBackground(deps, page.id);
    }
  }
  return page;
}

/** Automatic enrichment obeys the latest effective mode. */
export function processPageInBackground(deps: HandlerDeps, pageId: string): void {
  const privacyRevision = revisionFor(automaticPrivacyRevision, deps);
  const operation = startPageOperation(deps, pageId, {
    privacyRevision,
    apiKeyRevision: revisionFor(apiKeyRevision, deps),
  });
  void (async () => {
    const { apiKey, effectiveMode } = await currentMode(deps);
    if (!isCurrentPageOperation(deps, operation) || effectiveMode !== "hybrid" || !apiKey) {
      return;
    }
    // Send-time mode check: if Local-only was enabled after the initial check,
    // the callback will return false and no OpenAI request will be made.
    const processed = await deps.captureService.processPage(pageId, apiKey, async () => {
      const mode = await currentMode(deps);
      return mode.effectiveMode === "hybrid" && (await mayProceedPageOperation(deps, operation));
    });
    await broadcastCompletedPage(deps, operation, processed);
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
  const operation = startPageOperation(deps, pageId, {
    apiKeyRevision: revisionFor(apiKeyRevision, deps),
  });

  void deps.captureService
    .processPage(pageId, apiKey, async () => {
      const currentApiKey = await deps.apiKeyStore.getApiKey();
      return usableApiKey(currentApiKey) && mayProceedPageOperation(deps, operation);
    })
    .then((processed) => broadcastCompletedPage(deps, operation, processed))
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
  const libraryRevision = revisionFor(libraryOperationRevision, deps);
  const operationTokens = new Map(
    pageIds.map((pageId) => [
      pageId,
      startPageOperation(deps, pageId, {
        consentRevision,
        libraryRevision,
        apiKeyRevision: revisionFor(apiKeyRevision, deps),
      }),
    ]),
  );
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

      const operation = operationTokens.get(pageId);
      if (!operation) {
        throw new Error(`Bulk operation missing page ${pageId}`);
      }

      // Explicit confirmation is valid in either search mode, but canceling the
      // batch or removing the key revokes authorization before the next request.
      const maySend = async () => {
        const currentApiKey = await deps.apiKeyStore.getApiKey();
        return usableApiKey(currentApiKey) && (await mayProceedPageOperation(deps, operation));
      };
      const processed =
        kind === "enrich"
          ? await deps.captureService.processPage(pageId, apiKey, maySend)
          : await deps.captureService.reindexSemanticPage(pageId, apiKey, maySend);
      await broadcastCompletedPage(deps, operation, processed);

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
          persistentStorage: await deps.persistentStorage.getState(),
          storedMode: await deps.modeStore.getStoredMode(),
          effectiveMode: mode.effectiveMode,
        },
      };
    }

    case "settings.setApiKey": {
      incrementRevision(apiKeyRevision, deps);
      revokeAutomaticAndBulkWork(deps);
      await deps.apiKeyStore.setApiKey(request.payload.apiKey);
      deps.retrievalService.invalidate();
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
      deps.retrievalService.invalidate();
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
      const page = await savePageInBackground(deps, request.payload.tabId);
      return { type: "page.saved", payload: { page: toPageListItem(page) } };
    }

    case "page.list":
      return {
        type: "page.listed",
        payload: { pages: await deps.pageRepo.listPages(request.payload) },
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
      if (!page) {
        return { type: "page.urlStatus", payload: { saved: false } };
      }
      return {
        type: "page.urlStatus",
        payload: {
          saved: true,
          status: page.status,
          savedAt: page.savedAt,
          ...(page.localSaveError ? { localSaveError: page.localSaveError } : {}),
          ...(page.enrichmentError ? { enrichmentError: page.enrichmentError } : {}),
        },
      };
    }

    case "search.run": {
      const privacyRevision = revisionFor(automaticPrivacyRevision, deps);
      const { effectiveMode } = await currentMode(deps);
      const outcome = await deps.retrievalService.search({
        query: request.payload.query,
        topK: request.payload.topK,
        ...(request.payload.filter ? { filter: request.payload.filter } : {}),
        effectiveMode,
        resolveEffectiveMode: async () => {
          if (privacyRevision !== revisionFor(automaticPrivacyRevision, deps)) {
            return "local";
          }
          return (await currentMode(deps)).effectiveMode;
        },
      });
      return { type: "search.results", payload: outcome };
    }

    case "page.delete":
      incrementPageRevision(deps, request.payload.id);
      await deps.pageRepo.deleteWithChunks(request.payload.id);
      deps.retrievalService.invalidate();
      deps.broadcast({ type: "page.removed", payload: { id: request.payload.id } });
      return { type: "page.deleted", payload: { id: request.payload.id } };

    case "page.retry":
    case "page.addAiFeatures": {
      const pageId = request.type === "page.retry" ? request.payload.id : request.payload.pageId;
      const requestToken: PageOperationToken = {
        pageId,
        pageRevision: pageRevisionFor(deps, pageId),
        libraryRevision: revisionFor(libraryOperationRevision, deps),
        apiKeyRevision: revisionFor(apiKeyRevision, deps),
      };
      const page = await deps.pageRepo.getById(pageId);
      if (!page) {
        return { type: "error", payload: { message: `Page ${pageId} not found` } };
      }

      if (request.type === "page.retry" && page.status === "failed") {
        const retried = await deps.captureService.retryLocalPage(pageId);
        if (isCurrentPageOperation(deps, requestToken)) {
          const retryOperation = startPageOperation(deps, pageId, {
            apiKeyRevision: requestToken.apiKeyRevision,
          });
          await broadcastCompletedPage(deps, retryOperation, retried);
          if (isCurrentPageOperation(deps, retryOperation)) {
            processPageInBackground(deps, pageId);
          }
        }
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
      if (!(await mayProceedPageOperation(deps, requestToken))) {
        return { type: "error", payload: { message: `Page ${pageId} is no longer available` } };
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

    case "library.prepareBulkEnrich": {
      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!usableApiKey(apiKey)) {
        return { type: "error", payload: { message: "No API key set" } };
      }
      const pageIds = await deps.pageRepo.pageIdsKeywordReady();
      return {
        type: "library.bulkEnrichPrepared",
        payload: prepareBatch(deps, "enrich", pageIds),
      };
    }

    case "library.bulkEnrich": {
      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!usableApiKey(apiKey)) {
        return { type: "error", payload: { message: "No API key set" } };
      }
      const pageIds = takePreparedBatch(deps, "enrich", request.payload.batchId);
      if (!pageIds) {
        return {
          type: "error",
          payload: { message: "Bulk confirmation expired. Review the current page count again." },
        };
      }
      startBulkOperation(deps, "enrich", pageIds);
      return { type: "library.bulkEnrichStarted", payload: { total: pageIds.length } };
    }

    case "library.prepareReindexSemantic": {
      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!usableApiKey(apiKey)) {
        return { type: "error", payload: { message: "No API key set" } };
      }
      const pageIds = await deps.pageRepo.pageIdsNeedingSemanticIndex(
        deps.semanticIndex.embeddingModel,
        deps.semanticIndex.indexVersion,
      );
      return {
        type: "library.reindexSemanticPrepared",
        payload: prepareBatch(deps, "semantic", pageIds),
      };
    }

    case "library.reindexSemantic": {
      const apiKey = await deps.apiKeyStore.getApiKey();
      if (!usableApiKey(apiKey)) {
        return { type: "error", payload: { message: "No API key set" } };
      }
      const pageIds = takePreparedBatch(deps, "semantic", request.payload.batchId);
      if (!pageIds) {
        return {
          type: "error",
          payload: { message: "Bulk confirmation expired. Review the current page count again." },
        };
      }
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
      revokeAutomaticAndBulkWork(deps);
      incrementRevision(libraryOperationRevision, deps);
      explicitPages.delete(deps);
      preparedBatches.delete(deps);
      await deps.pageRepo.deleteAll();
      deps.retrievalService.invalidate();
      deps.broadcast({ type: "library.cleared" });
      return { type: "data.deletedAll" };

    case "data.import": {
      const libraryRevision = revisionFor(libraryOperationRevision, deps);
      const pages = parseBackup(request.payload.json);
      const result = await deps.pageRepo.importPages(pages, () =>
        isCurrentLibraryOperation(deps, libraryRevision),
      );
      if (isCurrentLibraryOperation(deps, libraryRevision)) {
        deps.retrievalService.invalidate();
        deps.broadcast({ type: "library.changed" });
      }
      return { type: "data.imported", payload: result };
    }

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
