import { describe, expect, it, vi } from "vitest";

import { normalizeUrl } from "../lib/urlNormalize";
import { APP_NAME, APP_VERSION } from "../shared/messages";
import type { PageHit, PageListItem, PageRecord } from "../shared/types";
import { handleMessage, handleRequest } from "./handlers";

const pendingPage = {
  id: "01HZ0000000000000000000000",
  url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API",
  urlHash: "a".repeat(64),
  title: "IndexedDB API",
  domain: "developer.mozilla.org",
  sourceType: "unknown",
  summary: "",
  topics: [],
  technologies: [],
  intent: "reference",
  fullText: "IndexedDB stores structured data.",
  savedAt: 100,
  visitedAt: 100,
  readingTimeMs: 2000,
  saveMode: "manual",
  status: "pending",
  schemaVersion: 1,
} satisfies PageRecord;

const pendingListItem = {
  id: pendingPage.id,
  url: pendingPage.url,
  title: pendingPage.title,
  domain: pendingPage.domain,
  sourceType: pendingPage.sourceType,
  summary: pendingPage.summary,
  topics: pendingPage.topics,
  technologies: pendingPage.technologies,
  savedAt: pendingPage.savedAt,
  status: pendingPage.status,
} satisfies PageListItem;

const searchHit = {
  page: pendingListItem,
  bestChunk: {
    text: "IndexedDB stores structured data.",
    ordinal: 0,
    highlightedHtml: "IndexedDB stores <mark>structured</mark> data.",
  },
  scores: { keyword: 1.5, vector: null, fused: 1.5 },
  matchReason: "keyword",
} satisfies PageHit;

describe("worker request handler", () => {
  it("responds to a ping request", async () => {
    await expect(handleRequest({ type: "devrecall.ping" }, makeDeps())).resolves.toEqual({
      type: "devrecall.pong",
      payload: { appName: APP_NAME, version: APP_VERSION },
    });
  });

  it("returns settings status with hasApiKey from store", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });

    await expect(handleRequest({ type: "settings.getStatus" }, deps)).resolves.toEqual({
      type: "settings.status",
      payload: { hasApiKey: true, persistentStorage: "unknown" },
    });
  });

  it("returns hasApiKey false when no key is stored", async () => {
    const deps = makeDeps({ apiKey: null });

    await expect(handleRequest({ type: "settings.getStatus" }, deps)).resolves.toEqual({
      type: "settings.status",
      payload: { hasApiKey: false, persistentStorage: "unknown" },
    });
  });

  it("stores an API key", async () => {
    const deps = makeDeps();

    await expect(
      handleRequest({ type: "settings.setApiKey", payload: { apiKey: "sk-new" } }, deps),
    ).resolves.toEqual({ type: "settings.apiKeySet" });
    expect(deps.apiKeyStore.setApiKey).toHaveBeenCalledWith("sk-new");
  });

  it("tests the OpenAI connection", async () => {
    const deps = makeDeps({
      apiKey: "sk-test",
      connectionResult: { success: true, message: "Connection successful" },
    });

    await expect(handleRequest({ type: "settings.testConnection" }, deps)).resolves.toEqual({
      type: "settings.connectionTestResult",
      payload: { success: true, message: "Connection successful" },
    });
  });

  it("saves the active tab as a pending page", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.captureService.save = vi.fn().mockResolvedValue(pendingPage);

    await expect(
      handleRequest({ type: "page.save", payload: { tabId: 7 } }, deps),
    ).resolves.toEqual({
      type: "page.saved",
      payload: { page: pendingListItem },
    });
    expect(deps.captureService.save).toHaveBeenCalledWith(7);
  });

  it("lists saved pages through PageRepo", async () => {
    const deps = makeDeps();
    deps.pageRepo.listPages = vi.fn().mockResolvedValue([pendingListItem]);

    await expect(
      handleRequest({ type: "page.list", payload: { limit: 25 } }, deps),
    ).resolves.toEqual({
      type: "page.listed",
      payload: { pages: [pendingListItem] },
    });
    expect(deps.pageRepo.listPages).toHaveBeenCalledWith({ limit: 25 });
  });

  it("runs a keyword search through RetrievalService", async () => {
    const deps = makeDeps();
    deps.retrievalService.search = vi.fn().mockResolvedValue([searchHit]);

    await expect(
      handleRequest({ type: "search.run", payload: { query: "structured data" } }, deps),
    ).resolves.toEqual({
      type: "search.results",
      payload: { hits: [searchHit] },
    });
    expect(deps.retrievalService.search).toHaveBeenCalledWith("structured data", {
      topK: undefined,
      apiKey: null,
    });
  });

  it("returns saved:false when the URL is unknown", async () => {
    const deps = makeDeps();
    deps.pageRepo.getByUrlHash = vi.fn().mockResolvedValue(undefined);

    await expect(
      handleRequest({ type: "page.statusForUrl", payload: { url: "https://example.com/x" } }, deps),
    ).resolves.toEqual({ type: "page.urlStatus", payload: { saved: false } });

    const { urlHash } = await normalizeUrl("https://example.com/x");
    expect(deps.pageRepo.getByUrlHash).toHaveBeenCalledWith(urlHash);
  });

  it("returns saved status with timestamp when the URL is known", async () => {
    const deps = makeDeps();
    deps.pageRepo.getByUrlHash = vi.fn().mockResolvedValue({
      ...pendingPage,
      status: "ready",
      savedAt: 1717000000000,
    });

    await expect(
      handleRequest({ type: "page.statusForUrl", payload: { url: pendingPage.url } }, deps),
    ).resolves.toEqual({
      type: "page.urlStatus",
      payload: { saved: true, status: "ready", savedAt: 1717000000000 },
    });

    const { urlHash } = await normalizeUrl(pendingPage.url);
    expect(deps.pageRepo.getByUrlHash).toHaveBeenCalledWith(urlHash);
  });

  it("responds with an error message when the handler throws", async () => {
    const deps = makeDeps();
    deps.captureService.save = vi
      .fn()
      .mockRejectedValue(
        new Error("Could not establish connection. Receiving end does not exist."),
      );
    const sendResponse = vi.fn();

    await handleMessage({ type: "page.save", payload: { tabId: 1 } }, sendResponse, deps);

    expect(sendResponse).toHaveBeenCalledWith({
      type: "error",
      payload: {
        message: "Could not establish connection. Receiving end does not exist.",
      },
    });
  });

  it("responds with the handler result when the handler succeeds", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.captureService.save = vi.fn().mockResolvedValue(pendingPage);
    const sendResponse = vi.fn();

    await handleMessage({ type: "page.save", payload: { tabId: 7 } }, sendResponse, deps);

    expect(sendResponse).toHaveBeenCalledWith({
      type: "page.saved",
      payload: { page: pendingListItem },
    });
  });

  it("broadcasts page.updated and invalidates on save, then again after processing", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.captureService.save = vi.fn().mockResolvedValue(pendingPage);
    deps.captureService.processPage = vi
      .fn()
      .mockResolvedValue({ ...pendingPage, status: "ready" });

    await handleRequest({ type: "page.save", payload: { tabId: 7 } }, deps);

    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "page.updated",
      payload: { page: pendingListItem },
    });
    expect(deps.retrievalService.invalidate).toHaveBeenCalled();

    // The processPage continuation broadcasts a second page.updated.
    await vi.waitFor(() => {
      expect(deps.broadcast).toHaveBeenCalledWith({
        type: "page.updated",
        payload: { page: { ...pendingListItem, status: "ready" } },
      });
    });
  });

  it("deletes a page, invalidates, and broadcasts removal", async () => {
    const deps = makeDeps();

    await expect(
      handleRequest({ type: "page.delete", payload: { id: "page-1" } }, deps),
    ).resolves.toEqual({ type: "page.deleted", payload: { id: "page-1" } });

    expect(deps.pageRepo.deleteWithChunks).toHaveBeenCalledWith("page-1");
    expect(deps.retrievalService.invalidate).toHaveBeenCalled();
    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "page.removed",
      payload: { id: "page-1" },
    });
  });

  it("retries a failed page by id, rebroadcasting pending then processed state", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    let resolveProcessed: ((page: PageRecord) => void) | undefined;
    const processedPromise = new Promise<PageRecord>((resolve) => {
      resolveProcessed = resolve;
    });
    deps.pageRepo.getById = vi
      .fn()
      .mockResolvedValue({ ...pendingPage, status: "failed", errorReason: "boom" });
    deps.pageRepo.updatePage = vi.fn().mockResolvedValue(undefined);
    deps.captureService.processPage = vi.fn().mockReturnValue(processedPromise);

    await expect(
      handleRequest({ type: "page.retry", payload: { id: pendingPage.id } }, deps),
    ).resolves.toEqual({
      type: "page.retryStarted",
      payload: { page: { ...pendingListItem, status: "pending" } },
    });

    expect(deps.pageRepo.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      status: "pending",
      errorReason: undefined,
    });
    expect(deps.retrievalService.invalidate).toHaveBeenCalledTimes(1);
    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "page.updated",
      payload: { page: { ...pendingListItem, status: "pending" } },
    });

    resolveProcessed?.({ ...pendingPage, status: "ready" });

    await vi.waitFor(() => {
      expect(deps.captureService.processPage).toHaveBeenCalledWith(pendingPage.id, "sk-test");
      expect(deps.retrievalService.invalidate).toHaveBeenCalledTimes(2);
      expect(deps.broadcast).toHaveBeenCalledWith({
        type: "page.updated",
        payload: { page: { ...pendingListItem, status: "ready" } },
      });
    });
  });

  it("rejects retry when the page is not failed", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.pageRepo.getById = vi.fn().mockResolvedValue({ ...pendingPage, status: "ready" });

    await expect(
      handleRequest({ type: "page.retry", payload: { id: pendingPage.id } }, deps),
    ).resolves.toEqual({
      type: "error",
      payload: { message: `Page ${pendingPage.id} is not failed` },
    });

    expect(deps.pageRepo.updatePage).not.toHaveBeenCalled();
    expect(deps.captureService.processPage).not.toHaveBeenCalled();
    expect(deps.retrievalService.invalidate).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("returns typed error response when retrying a page id that does not exist", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    // getById is already mocked to return undefined in makeDeps; make that explicit
    deps.pageRepo.getById = vi.fn().mockResolvedValue(undefined);

    await expect(
      handleRequest({ type: "page.retry", payload: { id: "nonexistent-id" } }, deps),
    ).resolves.toEqual({
      type: "error",
      payload: { message: "Page nonexistent-id not found" },
    });

    expect(deps.pageRepo.updatePage).not.toHaveBeenCalled();
    expect(deps.captureService.processPage).not.toHaveBeenCalled();
  });

  it("returns typed error response when retrying with no API key configured", async () => {
    const deps = makeDeps({ apiKey: null });
    deps.pageRepo.getById = vi
      .fn()
      .mockResolvedValue({ ...pendingPage, status: "failed", errorReason: "timeout" });

    await expect(
      handleRequest({ type: "page.retry", payload: { id: pendingPage.id } }, deps),
    ).resolves.toEqual({
      type: "error",
      payload: { message: "No API key set" },
    });

    expect(deps.pageRepo.updatePage).not.toHaveBeenCalled();
    expect(deps.captureService.processPage).not.toHaveBeenCalled();
  });

  it("starts a reindex and reports the total when a key is set", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.pageRepo.pageIdsMissingEmbeddings = vi.fn().mockResolvedValue(["a", "b"]);

    await expect(handleRequest({ type: "library.reindex" }, deps)).resolves.toEqual({
      type: "library.reindexStarted",
      payload: { total: 2 },
    });

    await vi.waitFor(() => {
      expect(deps.captureService.reindexPages).toHaveBeenCalledWith(
        ["a", "b"],
        "sk-test",
        expect.any(Function),
      );
    });
  });

  it("refuses to reindex without an API key", async () => {
    const deps = makeDeps({ apiKey: null });

    await expect(handleRequest({ type: "library.reindex" }, deps)).resolves.toEqual({
      type: "error",
      payload: { message: "No API key set" },
    });
    expect(deps.captureService.reindexPages).not.toHaveBeenCalled();
  });

  it("exports all pages as JSON with schemaVersion at the top level", async () => {
    const deps = makeDeps();
    deps.pageRepo.exportAll = vi.fn().mockResolvedValue([pendingPage]);

    const result = await handleRequest({ type: "data.export" }, deps);

    expect(result.type).toBe("data.exported");
    if (result.type === "data.exported") {
      const parsed = JSON.parse(result.payload.json) as { schemaVersion: number; pages: unknown[] };
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.pages).toHaveLength(1);
    }
    expect(deps.pageRepo.exportAll).toHaveBeenCalledOnce();
  });

  it("deletes all pages and chunks transactionally", async () => {
    const deps = makeDeps();
    deps.pageRepo.deleteAll = vi.fn().mockResolvedValue(undefined);

    await expect(handleRequest({ type: "data.deleteAll" }, deps)).resolves.toEqual({
      type: "data.deletedAll",
    });

    expect(deps.pageRepo.deleteAll).toHaveBeenCalledOnce();
    expect(deps.retrievalService.invalidate).toHaveBeenCalled();
    expect(deps.broadcast).toHaveBeenCalledWith({ type: "library.cleared" });
  });
});

function makeDeps(
  overrides: {
    apiKey?: string | null;
    connectionResult?: { success: boolean; message: string };
  } = {},
) {
  return {
    captureService: {
      save: vi.fn().mockResolvedValue(pendingPage),
      processPage: vi.fn().mockResolvedValue(pendingPage),
      reindexPages: vi.fn().mockResolvedValue(undefined),
    },
    pageRepo: {
      listPages: vi.fn().mockResolvedValue([]),
      getStats: vi
        .fn()
        .mockResolvedValue({ pageCount: 0, totalTextBytes: 0, pagesMissingEmbeddings: 0 }),
      getById: vi.fn().mockResolvedValue(undefined),
      getByUrlHash: vi.fn().mockResolvedValue(undefined),
      updatePage: vi.fn().mockResolvedValue(undefined),
      deleteWithChunks: vi.fn().mockResolvedValue(undefined),
      pageIdsMissingEmbeddings: vi.fn().mockResolvedValue([]),
      exportAll: vi.fn().mockResolvedValue([]),
      deleteAll: vi.fn().mockResolvedValue(undefined),
    },
    apiKeyStore: {
      getApiKey: vi.fn().mockResolvedValue(overrides.apiKey ?? null),
      setApiKey: vi.fn().mockResolvedValue(undefined),
    },
    testConnection: vi.fn().mockResolvedValue(
      overrides.connectionResult ?? {
        success: true,
        message: "Connection successful",
      },
    ),
    retrievalService: {
      search: vi.fn().mockResolvedValue([]),
      invalidate: vi.fn(),
    },
    broadcast: vi.fn(),
  };
}
