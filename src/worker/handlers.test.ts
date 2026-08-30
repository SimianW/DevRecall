import { describe, expect, it, vi } from "vitest";

import { ContentType, Platform } from "../shared/enums";
import type { PageHit, PageRecord } from "../shared/types";
import type { BulkTaskInput } from "./services/BulkTaskRunner";
import {
  handleMessage,
  handleRequest,
  processPageInBackground,
  recoverStaleEnriching,
  type HandlerDeps,
} from "./handlers";

const keywordReadyPage: PageRecord = {
  id: "page-1",
  url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API",
  urlHash: "a".repeat(64),
  title: "IndexedDB API",
  domain: "developer.mozilla.org",
  platform: Platform.Mdn,
  contentType: ContentType.Documentation,
  summary: "",
  topics: [],
  technologies: [],
  intent: "reference",
  fullText: "IndexedDB stores structured data.",
  savedAt: 100,
  visitedAt: 100,
  readingTimeMs: 2000,
  saveMode: "manual",
  status: "keyword_ready",
  schemaVersion: 1,
};

const searchHit: PageHit = {
  page: {
    id: keywordReadyPage.id,
    url: keywordReadyPage.url,
    title: keywordReadyPage.title,
    domain: keywordReadyPage.domain,
    platform: keywordReadyPage.platform,
    contentType: keywordReadyPage.contentType,
    summary: "",
    topics: [],
    technologies: [],
    savedAt: 100,
    status: "keyword_ready",
  },
  bestChunk: {
    text: keywordReadyPage.fullText,
    ordinal: 0,
    highlightedHtml: "<mark>IndexedDB</mark> stores structured data.",
  },
  metadataMatches: { titleHighlightedHtml: null, summaryHighlightedHtml: null },
  scores: { keyword: 1, vector: null, fused: 1 / 61 },
  matchReason: "keyword",
};

async function prepareBulkEnrich(deps: HandlerDeps): Promise<string> {
  const response = await handleRequest({ type: "library.prepareBulkEnrich", payload: {} }, deps);
  if (response.type !== "library.bulkEnrichPrepared") {
    throw new Error(`Could not prepare bulk enrichment: ${response.type}`);
  }
  return response.payload.batchId;
}

async function prepareSemanticReindex(deps: HandlerDeps): Promise<string> {
  const response = await handleRequest(
    { type: "library.prepareReindexSemantic", payload: {} },
    deps,
  );
  if (response.type !== "library.reindexSemanticPrepared") {
    throw new Error(`Could not prepare semantic re-index: ${response.type}`);
  }
  return response.payload.batchId;
}

describe("worker request handler", () => {
  it("reports stored and effective mode without overwriting a missing-key preference", async () => {
    const deps = makeDeps({ apiKey: null, storedMode: "hybrid" });

    await expect(handleRequest({ type: "settings.getStatus" }, deps)).resolves.toEqual({
      type: "settings.status",
      payload: {
        hasApiKey: false,
        persistentStorage: "unknown",
        storedMode: "hybrid",
        effectiveMode: "local",
      },
    });
    expect(deps.modeStore.setStoredMode).not.toHaveBeenCalled();
  });

  it("stores Local-only and stops a running bulk queue", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "hybrid" });

    await expect(
      handleRequest({ type: "settings.setMode", payload: { mode: "local" } }, deps),
    ).resolves.toEqual({
      type: "settings.modeSet",
      payload: { storedMode: "local", effectiveMode: "local" },
    });
    expect(deps.modeStore.setStoredMode).toHaveBeenCalledWith("local");
    expect(deps.bulkRunner.cancel).toHaveBeenCalledOnce();
  });

  it("a newer Local-only choice revokes an existing batch consent", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "local" });
    deps.pageRepo.pageIdsKeywordReady = vi.fn().mockResolvedValue(["a", "b"]);

    const firstBatchId = await prepareBulkEnrich(deps);
    await handleRequest({ type: "library.bulkEnrich", payload: { batchId: firstBatchId } }, deps);
    const firstRun = vi.mocked(deps.bulkRunner.begin).mock.calls[0][0];
    await expect(firstRun.shouldContinue()).resolves.toBe(true);

    await handleRequest({ type: "settings.setMode", payload: { mode: "local" } }, deps);
    await expect(firstRun.shouldContinue()).resolves.toBe(false);

    const reconfirmedBatchId = await prepareBulkEnrich(deps);
    await handleRequest(
      { type: "library.bulkEnrich", payload: { batchId: reconfirmedBatchId } },
      deps,
    );
    const reconfirmedRun = vi.mocked(deps.bulkRunner.begin).mock.calls[1][0];
    await expect(reconfirmedRun.shouldContinue()).resolves.toBe(true);
  });

  it("removing the key stops bulk work but preserves the stored preference", async () => {
    const deps = makeDeps({ storedMode: "hybrid" });

    await handleRequest({ type: "settings.setApiKey", payload: { apiKey: "" } }, deps);

    expect(deps.apiKeyStore.setApiKey).toHaveBeenCalledWith("");
    expect(deps.modeStore.setStoredMode).not.toHaveBeenCalled();
    expect(deps.bulkRunner.cancel).toHaveBeenCalledOnce();
  });

  it("key removal and Cancel revoke the captured batch consent", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "local" });
    deps.pageRepo.pageIdsKeywordReady = vi.fn().mockResolvedValue(["a"]);

    const beforeRemovalBatchId = await prepareBulkEnrich(deps);
    await handleRequest(
      { type: "library.bulkEnrich", payload: { batchId: beforeRemovalBatchId } },
      deps,
    );
    const beforeKeyRemoval = vi.mocked(deps.bulkRunner.begin).mock.calls[0][0];
    await expect(beforeKeyRemoval.shouldContinue()).resolves.toBe(true);

    await handleRequest({ type: "settings.setApiKey", payload: { apiKey: "" } }, deps);
    await expect(beforeKeyRemoval.shouldContinue()).resolves.toBe(false);

    vi.mocked(deps.apiKeyStore.getApiKey).mockResolvedValue("sk-restored");
    const beforeCancelBatchId = await prepareBulkEnrich(deps);
    await handleRequest(
      { type: "library.bulkEnrich", payload: { batchId: beforeCancelBatchId } },
      deps,
    );
    const beforeCancel = vi.mocked(deps.bulkRunner.begin).mock.calls[1][0];
    await expect(beforeCancel.shouldContinue()).resolves.toBe(true);

    await handleRequest({ type: "library.cancelBulk", payload: {} }, deps);
    await expect(beforeCancel.shouldContinue()).resolves.toBe(false);
  });

  it("adding a key or selecting Hybrid does not start bulk work", async () => {
    const deps = makeDeps({ apiKey: null, storedMode: "local" });

    await handleRequest({ type: "settings.setApiKey", payload: { apiKey: "sk-new" } }, deps);
    await handleRequest({ type: "settings.setMode", payload: { mode: "hybrid" } }, deps);

    expect(deps.bulkRunner.begin).not.toHaveBeenCalled();
  });

  it("broadcasts settings.changed when API key is set", async () => {
    const deps = makeDeps({ apiKey: null, storedMode: "hybrid" });

    await handleRequest({ type: "settings.setApiKey", payload: { apiKey: "sk-test" } }, deps);

    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "settings.changed",
      payload: { hasApiKey: true, storedMode: "hybrid", effectiveMode: "hybrid" },
    });
  });

  it("broadcasts settings.changed when API key is removed", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "hybrid" });

    await handleRequest({ type: "settings.setApiKey", payload: { apiKey: "" } }, deps);

    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "settings.changed",
      payload: { hasApiKey: false, storedMode: "hybrid", effectiveMode: "local" },
    });
  });

  it("broadcasts settings.changed when mode is changed", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "hybrid" });

    await handleRequest({ type: "settings.setMode", payload: { mode: "local" } }, deps);

    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "settings.changed",
      payload: { hasApiKey: true, storedMode: "local", effectiveMode: "local" },
    });
  });

  it("saves locally and skips automatic enrichment in Local-only", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "local" });

    const response = await handleRequest({ type: "page.save", payload: { tabId: 7 } }, deps);

    expect(response).toMatchObject({
      type: "page.saved",
      payload: { page: { status: "keyword_ready" } },
    });
    await Promise.resolve();
    expect(deps.captureService.processPage).not.toHaveBeenCalled();
  });

  it("a Local-only change during mode resolution blocks automatic enrichment", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "hybrid" });
    let releaseMode: ((mode: "hybrid") => void) | undefined;
    const staleHybrid = new Promise<"hybrid">((resolve) => {
      releaseMode = resolve;
    });
    vi.mocked(deps.modeStore.getEffectiveMode)
      .mockImplementationOnce(async () => staleHybrid)
      .mockResolvedValueOnce("local");

    processPageInBackground(deps, keywordReadyPage.id);
    await vi.waitFor(() => expect(deps.modeStore.getEffectiveMode).toHaveBeenCalledOnce());

    await handleRequest({ type: "settings.setMode", payload: { mode: "local" } }, deps);
    releaseMode?.("hybrid");
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.captureService.processPage).not.toHaveBeenCalled();
  });

  it("starts automatic enrichment after a Hybrid local save", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "hybrid" });

    await handleRequest({ type: "page.save", payload: { tabId: 7 } }, deps);

    await vi.waitFor(() =>
      expect(deps.captureService.processPage).toHaveBeenCalledWith(
        keywordReadyPage.id,
        "sk-test",
        expect.any(Function),
      ),
    );
  });

  it("passes the effective mode to search and returns the actual search mode", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "hybrid" });
    deps.retrievalService.search = vi.fn().mockResolvedValue({
      results: [searchHit],
      searchMode: "keyword_fallback",
    });

    await expect(
      handleRequest({ type: "search.run", payload: { query: "indexed db", topK: 5 } }, deps),
    ).resolves.toEqual({
      type: "search.results",
      payload: { results: [searchHit], searchMode: "keyword_fallback" },
    });
    expect(deps.retrievalService.search).toHaveBeenCalledWith({
      query: "indexed db",
      topK: 5,
      effectiveMode: "hybrid",
      resolveEffectiveMode: expect.any(Function),
    });
  });

  it("revokes an active search before a Local-only mode write finishes", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "hybrid" });
    let finishSearch: (() => void) | undefined;
    deps.retrievalService.search = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSearch = () => resolve({ results: [], searchMode: "local" });
        }),
    );

    const searchRequest = handleRequest(
      { type: "search.run", payload: { query: "indexed db" } },
      deps,
    );
    await vi.waitFor(() => expect(deps.retrievalService.search).toHaveBeenCalledOnce());

    let finishModeWrite: (() => void) | undefined;
    vi.mocked(deps.modeStore.setStoredMode).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishModeWrite = resolve;
        }),
    );
    const modeRequest = handleRequest(
      { type: "settings.setMode", payload: { mode: "local" } },
      deps,
    );

    const input = vi.mocked(deps.retrievalService.search).mock.calls[0][0];
    if (!input.resolveEffectiveMode) {
      throw new Error("expected a send-time mode resolver");
    }
    await expect(input.resolveEffectiveMode()).resolves.toBe("local");

    finishModeWrite?.();
    finishSearch?.();
    await Promise.all([modeRequest, searchRequest]);
  });

  it("reports a persisted local capture failure for the current URL", async () => {
    const deps = makeDeps();
    deps.pageRepo.getByUrlHash = vi.fn().mockResolvedValue({
      ...keywordReadyPage,
      status: "failed",
      localSaveError: "IndexedDB quota exceeded",
    });

    await expect(
      handleRequest({ type: "page.statusForUrl", payload: { url: keywordReadyPage.url } }, deps),
    ).resolves.toEqual({
      type: "page.urlStatus",
      payload: {
        saved: true,
        status: "failed",
        savedAt: keywordReadyPage.savedAt,
        localSaveError: "IndexedDB quota exceeded",
      },
    });
  });

  it("allows explicit per-page enrichment in Local-only", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "local" });
    deps.pageRepo.getById = vi.fn().mockResolvedValue(keywordReadyPage);

    const response = await handleRequest(
      { type: "page.addAiFeatures", payload: { pageId: keywordReadyPage.id } },
      deps,
    );

    expect(response).toMatchObject({
      type: "page.aiFeaturesStarted",
      payload: { page: { status: "enriching" } },
    });
    await vi.waitFor(() =>
      expect(deps.captureService.processPage).toHaveBeenCalledWith(keywordReadyPage.id, "sk-test"),
    );
    expect(deps.modeStore.setStoredMode).not.toHaveBeenCalled();
  });

  it("rejects explicit enrichment without a key", async () => {
    const deps = makeDeps({ apiKey: null });
    deps.pageRepo.getById = vi.fn().mockResolvedValue(keywordReadyPage);

    await expect(
      handleRequest({ type: "page.addAiFeatures", payload: { pageId: keywordReadyPage.id } }, deps),
    ).resolves.toEqual({ type: "error", payload: { message: "No API key set" } });
  });

  it("rejects retry when the page has no stored enrichment error", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.pageRepo.getById = vi.fn().mockResolvedValue(keywordReadyPage);

    await expect(
      handleRequest({ type: "page.retry", payload: { id: keywordReadyPage.id } }, deps),
    ).resolves.toEqual({
      type: "error",
      payload: { message: `Page ${keywordReadyPage.id} has no AI enrichment error to retry` },
    });
    expect(deps.captureService.processPage).not.toHaveBeenCalled();
  });

  it("rebuilds a failed local save without requiring an API key", async () => {
    const deps = makeDeps({ apiKey: null, storedMode: "hybrid" });
    deps.pageRepo.getById = vi.fn().mockResolvedValue({
      ...keywordReadyPage,
      status: "failed",
      localSaveError: "local write failed",
    });

    await expect(
      handleRequest({ type: "page.retry", payload: { id: keywordReadyPage.id } }, deps),
    ).resolves.toMatchObject({
      type: "page.retryStarted",
      payload: { page: { status: "keyword_ready" } },
    });
    expect(deps.captureService.retryLocalPage).toHaveBeenCalledWith(keywordReadyPage.id);
    await Promise.resolve();
    expect(deps.captureService.processPage).not.toHaveBeenCalled();
  });

  it("automatically enriches a rebuilt local save only when Hybrid is effective", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "hybrid" });
    deps.pageRepo.getById = vi.fn().mockResolvedValue({
      ...keywordReadyPage,
      status: "failed",
      localSaveError: "local write failed",
    });

    await handleRequest({ type: "page.retry", payload: { id: keywordReadyPage.id } }, deps);

    await vi.waitFor(() =>
      expect(deps.captureService.processPage).toHaveBeenCalledWith(
        keywordReadyPage.id,
        "sk-test",
        expect.any(Function),
      ),
    );
  });

  it("prevents two explicit requests for the same in-flight page", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "local" });
    deps.pageRepo.getById = vi.fn().mockResolvedValue(keywordReadyPage);
    let finish: ((page: PageRecord) => void) | undefined;
    deps.captureService.processPage = vi.fn(
      () =>
        new Promise<PageRecord>((resolve) => {
          finish = resolve;
        }),
    );

    await handleRequest(
      { type: "page.addAiFeatures", payload: { pageId: keywordReadyPage.id } },
      deps,
    );
    await expect(
      handleRequest({ type: "page.addAiFeatures", payload: { pageId: keywordReadyPage.id } }, deps),
    ).resolves.toEqual({
      type: "error",
      payload: { message: `AI features are already being added to page ${keywordReadyPage.id}` },
    });
    expect(deps.captureService.processPage).toHaveBeenCalledOnce();

    finish?.({ ...keywordReadyPage, status: "ready" });
  });

  it("starts confirmed bulk enrichment with exactly the eligible pages", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "local" });
    deps.pageRepo.pageIdsKeywordReady = vi.fn().mockResolvedValue(["a", "b"]);
    const batchId = await prepareBulkEnrich(deps);

    await expect(
      handleRequest({ type: "library.bulkEnrich", payload: { batchId } }, deps),
    ).resolves.toEqual({ type: "library.bulkEnrichStarted", payload: { total: 2 } });

    const input = vi.mocked(deps.bulkRunner.begin).mock.calls[0][0];
    expect(input.kind).toBe("enrich");
    expect(input.pageIds).toEqual(["a", "b"]);
    expect(await input.shouldContinue()).toBe(true);
  });

  it("starts bulk enrichment from the exact worker snapshot shown for confirmation", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "local" });
    deps.pageRepo.pageIdsKeywordReady = vi
      .fn()
      .mockResolvedValueOnce(["a", "b"])
      .mockResolvedValueOnce(["a", "b", "new-after-confirmation"]);

    const prepared = await handleRequest({ type: "library.prepareBulkEnrich", payload: {} }, deps);
    expect(prepared).toMatchObject({
      type: "library.bulkEnrichPrepared",
      payload: { count: 2, batchId: expect.any(String) },
    });
    if (prepared.type !== "library.bulkEnrichPrepared") {
      throw new Error("Expected a prepared bulk snapshot");
    }

    await expect(
      handleRequest(
        { type: "library.bulkEnrich", payload: { batchId: prepared.payload.batchId } },
        deps,
      ),
    ).resolves.toEqual({ type: "library.bulkEnrichStarted", payload: { total: 2 } });

    expect(vi.mocked(deps.bulkRunner.begin).mock.calls[0][0].pageIds).toEqual(["a", "b"]);
    expect(deps.pageRepo.pageIdsKeywordReady).toHaveBeenCalledOnce();
  });

  it("uses the key checked by the per-page consent gate", async () => {
    const deps = makeDeps({ apiKey: "sk-current", storedMode: "local" });
    deps.pageRepo.pageIdsKeywordReady = vi.fn().mockResolvedValue(["a"]);
    const batchId = await prepareBulkEnrich(deps);

    await handleRequest({ type: "library.bulkEnrich", payload: { batchId } }, deps);
    const input = vi.mocked(deps.bulkRunner.begin).mock.calls[0][0];

    await expect(input.shouldContinue()).resolves.toBe(true);
    await input.runPage("a");

    expect(deps.captureService.processPage).toHaveBeenCalledWith(
      "a",
      "sk-current",
      expect.any(Function),
    );
  });

  it("keeps a confirmed bulk page authorized while Local-only remains selected", async () => {
    const deps = makeDeps({ apiKey: "sk-current", storedMode: "local" });
    deps.pageRepo.pageIdsKeywordReady = vi.fn().mockResolvedValue(["a"]);
    const batchId = await prepareBulkEnrich(deps);

    await handleRequest({ type: "library.bulkEnrich", payload: { batchId } }, deps);
    const input = vi.mocked(deps.bulkRunner.begin).mock.calls[0][0];

    await expect(input.shouldContinue()).resolves.toBe(true);
    await input.runPage("a");
    const maySend = vi.mocked(deps.captureService.processPage).mock.calls[0][2];

    await expect(maySend?.()).resolves.toBe(true);
  });

  it("starts semantic re-index separately with version-aware candidates", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.pageRepo.pageIdsNeedingSemanticIndex = vi.fn().mockResolvedValue(["ready-1"]);
    const batchId = await prepareSemanticReindex(deps);

    await expect(
      handleRequest({ type: "library.reindexSemantic", payload: { batchId } }, deps),
    ).resolves.toEqual({ type: "library.reindexSemanticStarted", payload: { total: 1 } });
    expect(deps.pageRepo.pageIdsNeedingSemanticIndex).toHaveBeenCalledWith("model-v1", 1);
    expect(vi.mocked(deps.bulkRunner.begin).mock.calls[0][0].kind).toBe("semantic");
  });

  it("semantic re-index calls only the embedding repair path", async () => {
    const deps = makeDeps({ apiKey: "sk-test", storedMode: "local" });
    deps.pageRepo.pageIdsNeedingSemanticIndex = vi.fn().mockResolvedValue(["ready-1"]);
    const batchId = await prepareSemanticReindex(deps);

    await handleRequest({ type: "library.reindexSemantic", payload: { batchId } }, deps);
    const input = vi.mocked(deps.bulkRunner.begin).mock.calls[0][0];

    await expect(input.shouldContinue()).resolves.toBe(true);
    await input.runPage("ready-1");

    expect(deps.captureService.reindexSemanticPage).toHaveBeenCalledWith(
      "ready-1",
      "sk-test",
      expect.any(Function),
    );
    expect(deps.captureService.processPage).not.toHaveBeenCalled();
  });

  it("uses version-aware candidates in the Settings count", async () => {
    const deps = makeDeps();
    deps.pageRepo.getStats = vi
      .fn()
      .mockResolvedValue({ pageCount: 4, totalTextBytes: 100, pagesMissingEmbeddings: 0 });
    deps.pageRepo.pageIdsNeedingSemanticIndex = vi.fn().mockResolvedValue(["a", "b"]);

    await expect(handleRequest({ type: "storage.getStats" }, deps)).resolves.toEqual({
      type: "storage.stats",
      payload: { pageCount: 4, totalTextBytes: 100, pagesMissingEmbeddings: 2 },
    });
  });

  it("recovers stale enriching records without replaying them", async () => {
    const deps = makeDeps();
    deps.captureService.recoverStaleEnriching = vi.fn().mockResolvedValue(3);

    await expect(recoverStaleEnriching(deps)).resolves.toBe(3);
    expect(deps.captureService.processPage).not.toHaveBeenCalled();
  });

  it("converts thrown handler errors to typed responses", async () => {
    const deps = makeDeps();
    deps.captureService.save = vi.fn().mockRejectedValue(new Error("capture failed"));
    const sendResponse = vi.fn();

    await handleMessage({ type: "page.save", payload: { tabId: 1 } }, sendResponse, deps);

    expect(sendResponse).toHaveBeenCalledWith({
      type: "error",
      payload: { message: "capture failed" },
    });
  });
});

function makeDeps(
  options: { apiKey?: string | null; storedMode?: "local" | "hybrid" } = {},
): HandlerDeps & {
  bulkRunner: HandlerDeps["bulkRunner"] & { begin: ReturnType<typeof vi.fn> };
} {
  let storedMode = options.storedMode ?? "hybrid";
  let currentApiKey: string | null = options.apiKey === undefined ? null : options.apiKey;
  const processPage = vi.fn().mockResolvedValue({ ...keywordReadyPage, status: "ready" });

  return {
    captureService: {
      save: vi.fn().mockResolvedValue(keywordReadyPage),
      retryLocalPage: vi.fn().mockResolvedValue(keywordReadyPage),
      processPage,
      reindexSemanticPage: vi.fn().mockResolvedValue({ ...keywordReadyPage, status: "ready" }),
      recoverStaleEnriching: vi.fn().mockResolvedValue(0),
    },
    pageRepo: {
      listPages: vi.fn().mockResolvedValue([]),
      getStats: vi
        .fn()
        .mockResolvedValue({ pageCount: 0, totalTextBytes: 0, pagesMissingEmbeddings: 0 }),
      getById: vi.fn().mockResolvedValue(undefined),
      getByUrlHash: vi.fn().mockResolvedValue(undefined),
      deleteWithChunks: vi.fn().mockResolvedValue(undefined),
      pageIdsKeywordReady: vi.fn().mockResolvedValue([]),
      pageIdsNeedingSemanticIndex: vi.fn().mockResolvedValue([]),
      exportAll: vi.fn().mockResolvedValue([]),
      deleteAll: vi.fn().mockResolvedValue(undefined),
    },
    apiKeyStore: {
      getApiKey: vi.fn().mockImplementation(async () => currentApiKey),
      setApiKey: vi.fn().mockImplementation(async (key: string) => {
        currentApiKey = key;
      }),
    },
    modeStore: {
      getStoredMode: vi.fn(async () => storedMode),
      setStoredMode: vi.fn(async (mode: "local" | "hybrid") => {
        storedMode = mode;
      }),
      getEffectiveMode: vi.fn(async (hasApiKey: boolean) =>
        storedMode === "hybrid" && hasApiKey ? "hybrid" : "local",
      ),
      getDefaultEffectiveMode: vi.fn((hasApiKey: boolean) =>
        storedMode === "hybrid" && hasApiKey ? "hybrid" : "local",
      ),
    },
    testConnection: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    retrievalService: {
      search: vi.fn().mockResolvedValue({ results: [], searchMode: "local" }),
      invalidate: vi.fn(),
    },
    bulkRunner: {
      begin: vi.fn((_input: BulkTaskInput) => undefined),
      cancel: vi.fn().mockReturnValue(true),
      isRunning: vi.fn().mockReturnValue(false),
    },
    semanticIndex: { embeddingModel: "model-v1", indexVersion: 1 },
    broadcast: vi.fn(),
    autoSaveSettings: {
      isEnabled: vi.fn().mockResolvedValue(false),
      setEnabled: vi.fn().mockResolvedValue(undefined),
    },
  };
}
