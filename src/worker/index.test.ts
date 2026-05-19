import { describe, expect, it, vi } from "vitest";

import { APP_NAME, APP_VERSION } from "../shared/messages";
import type { PageListItem, PageRecord } from "../shared/types";
import { handleRequest } from "./index";

const pageRecord = {
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
  status: "ready",
  schemaVersion: 1,
} satisfies PageRecord;

const pageListItem = {
  id: pageRecord.id,
  url: pageRecord.url,
  title: pageRecord.title,
  domain: pageRecord.domain,
  sourceType: pageRecord.sourceType,
  summary: pageRecord.summary,
  topics: pageRecord.topics,
  technologies: pageRecord.technologies,
  savedAt: pageRecord.savedAt,
  status: pageRecord.status,
} satisfies PageListItem;

describe("worker request handler", () => {
  it("responds to a ping request", async () => {
    await expect(handleRequest({ type: "devrecall.ping" })).resolves.toEqual({
      type: "devrecall.pong",
      payload: {
        appName: APP_NAME,
        version: APP_VERSION,
      },
    });
  });

  it("returns the initial settings status", async () => {
    await expect(
      handleRequest({ type: "settings.getStatus" }),
    ).resolves.toEqual({
      type: "settings.status",
      payload: {
        hasApiKey: false,
        persistentStorage: "unknown",
      },
    });
  });

  it("saves the active tab through CaptureService", async () => {
    const captureService = {
      save: vi.fn().mockResolvedValue(pageRecord),
    };
    const pageRepo = {
      listPages: vi.fn(),
    };

    await expect(
      handleRequest(
        { type: "page.save", payload: { tabId: 7 } },
        { captureService, pageRepo },
      ),
    ).resolves.toEqual({
      type: "page.saved",
      payload: { page: pageListItem },
    });
    expect(captureService.save).toHaveBeenCalledWith(7);
  });

  it("lists saved pages through PageRepo", async () => {
    const captureService = {
      save: vi.fn(),
    };
    const pageRepo = {
      listPages: vi.fn().mockResolvedValue([pageListItem]),
    };

    await expect(
      handleRequest(
        { type: "page.list", payload: { limit: 25 } },
        { captureService, pageRepo },
      ),
    ).resolves.toEqual({
      type: "page.listed",
      payload: { pages: [pageListItem] },
    });
    expect(pageRepo.listPages).toHaveBeenCalledWith({ limit: 25 });
  });
});
