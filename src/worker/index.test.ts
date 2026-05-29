import { describe, expect, it, vi } from "vitest";

import { normalizeUrl } from "../lib/urlNormalize";
import { APP_NAME, APP_VERSION } from "../shared/messages";
import type { PageListItem, PageRecord } from "../shared/types";
import { handleMessage, handleRequest } from "./index";

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

describe("worker request handler", () => {
  it("responds to a ping request", async () => {
    await expect(
      handleRequest({ type: "devrecall.ping" }, makeDeps()),
    ).resolves.toEqual({
      type: "devrecall.pong",
      payload: { appName: APP_NAME, version: APP_VERSION },
    });
  });

  it("returns settings status with hasApiKey from store", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });

    await expect(
      handleRequest({ type: "settings.getStatus" }, deps),
    ).resolves.toEqual({
      type: "settings.status",
      payload: { hasApiKey: true, persistentStorage: "unknown" },
    });
  });

  it("returns hasApiKey false when no key is stored", async () => {
    const deps = makeDeps({ apiKey: null });

    await expect(
      handleRequest({ type: "settings.getStatus" }, deps),
    ).resolves.toEqual({
      type: "settings.status",
      payload: { hasApiKey: false, persistentStorage: "unknown" },
    });
  });

  it("stores an API key", async () => {
    const deps = makeDeps();

    await expect(
      handleRequest(
        { type: "settings.setApiKey", payload: { apiKey: "sk-new" } },
        deps,
      ),
    ).resolves.toEqual({ type: "settings.apiKeySet" });
    expect(deps.apiKeyStore.setApiKey).toHaveBeenCalledWith("sk-new");
  });

  it("tests the OpenAI connection", async () => {
    const deps = makeDeps({
      apiKey: "sk-test",
      connectionResult: { success: true, message: "Connection successful" },
    });

    await expect(
      handleRequest({ type: "settings.testConnection" }, deps),
    ).resolves.toEqual({
      type: "settings.connectionTestResult",
      payload: { success: true, message: "Connection successful" },
    });
  });

  it("saves the active tab as a pending page", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.captureService.save = vi.fn().mockResolvedValue(pendingPage);

    await expect(
      handleRequest(
        { type: "page.save", payload: { tabId: 7 } },
        deps,
      ),
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
      handleRequest(
        { type: "page.list", payload: { limit: 25 } },
        deps,
      ),
    ).resolves.toEqual({
      type: "page.listed",
      payload: { pages: [pendingListItem] },
    });
    expect(deps.pageRepo.listPages).toHaveBeenCalledWith({ limit: 25 });
  });

  it("returns saved:false when the URL is unknown", async () => {
    const deps = makeDeps();
    deps.pageRepo.getByUrlHash = vi.fn().mockResolvedValue(undefined);

    await expect(
      handleRequest(
        { type: "page.statusForUrl", payload: { url: "https://example.com/x" } },
        deps,
      ),
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
      handleRequest(
        { type: "page.statusForUrl", payload: { url: pendingPage.url } },
        deps,
      ),
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

    await handleMessage(
      { type: "page.save", payload: { tabId: 1 } },
      sendResponse,
      deps,
    );

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

    await handleMessage(
      { type: "page.save", payload: { tabId: 7 } },
      sendResponse,
      deps,
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: "page.saved",
      payload: { page: pendingListItem },
    });
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
    },
    pageRepo: {
      listPages: vi.fn().mockResolvedValue([]),
      getStats: vi.fn().mockResolvedValue({ pageCount: 0, totalTextBytes: 0 }),
      getByUrlHash: vi.fn().mockResolvedValue(undefined),
    },
    apiKeyStore: {
      getApiKey: vi.fn().mockResolvedValue(overrides.apiKey ?? null),
      setApiKey: vi.fn().mockResolvedValue(undefined),
    },
    testConnection: vi
      .fn()
      .mockResolvedValue(
        overrides.connectionResult ?? {
          success: true,
          message: "Connection successful",
        },
      ),
  };
}
