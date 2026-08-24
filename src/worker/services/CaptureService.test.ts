import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentType, Platform } from "../../shared/enums";
import type { ExtractedPage, PageRecord } from "../../shared/types";
import { ChunkRepo } from "../repository/ChunkRepo";
import { DevRecallDatabase } from "../repository/db";
import { PageRepo } from "../repository/PageRepo";
import { MockLLMProvider } from "../llm/MockLLMProvider";
import type { Embedder, PageTaggingResult } from "../llm/OpenAIProvider";
import {
  CaptureService,
  ChromePageExtractor,
  SEMANTIC_INDEX_VERSION,
  mergeFrameExtractions,
  type ChunkWriter,
  type FrameExtraction,
  type PageExtractor,
  type PageReader,
  type PageTagger,
  type PageWriter,
} from "./CaptureService";

const extracted: ExtractedPage = {
  url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
  title: "Horizontal Pod Autoscaling",
  fullText: "Autoscaling docs",
  readingTimeMs: 30_000,
};

const pendingPage: PageRecord = {
  id: "01HZ0000000000000000000000",
  url: extracted.url,
  urlHash: "a".repeat(64),
  title: extracted.title,
  domain: "kubernetes.io",
  platform: Platform.Web,
  contentType: ContentType.Documentation,
  summary: "",
  topics: [],
  technologies: [],
  intent: "reference",
  fullText: extracted.fullText,
  savedAt: 1,
  visitedAt: 1,
  readingTimeMs: extracted.readingTimeMs,
  saveMode: "manual",
  status: "pending",
  schemaVersion: 1,
};

const taggingResult: PageTaggingResult = {
  summary: "HPA autoscales pods based on metrics.",
  contentType: ContentType.Documentation,
  topics: ["kubernetes", "autoscaling"],
  technologies: ["Kubernetes"],
  intent: "reference",
};

function mockEmbedder(overrides: Partial<Embedder> = {}): Embedder {
  return {
    embeddingModel: "mock:embedding",
    embed: vi.fn(),
    embedBatch: vi.fn().mockResolvedValue([Float32Array.from([1, 0, 0])]),
    ...overrides,
  };
}

function mockChunkWriter(): ChunkWriter {
  return {
    replaceChunksForPage: vi.fn().mockResolvedValue([]),
    commitProcessedPage: vi.fn().mockResolvedValue([]),
  };
}

function mockReader(page: PageRecord | undefined = pendingPage): PageReader {
  return {
    getById: vi.fn().mockResolvedValue(page),
    claimEnrichment: vi.fn(async () => {
      if (!page) {
        throw new Error("Page not found");
      }
      if (page.status !== "keyword_ready") {
        throw new Error(`Page ${page.id} is not eligible for enrichment (${page.status})`);
      }
      return { ...page, status: "enriching", enrichmentError: undefined } satisfies PageRecord;
    }),
    updatePage: vi.fn().mockResolvedValue(undefined),
    recoverStaleEnriching: vi.fn().mockResolvedValue(0),
  };
}

describe("CaptureService", () => {
  it("extracts the tab and atomically commits a keyword-ready page with word chunks", async () => {
    const extractor: PageExtractor = { extract: vi.fn().mockResolvedValue(extracted) };
    const keywordReadyPage: PageRecord = { ...pendingPage, status: "keyword_ready" };
    const writer: PageWriter = {
      commitCapturedPage: vi.fn().mockResolvedValue(keywordReadyPage),
    };
    const chunkWriter = mockChunkWriter();

    const result = await new CaptureService(
      writer,
      extractor,
      undefined,
      undefined,
      chunkWriter,
    ).save(123);

    expect(extractor.extract).toHaveBeenCalledWith(123);
    expect(writer.commitCapturedPage).toHaveBeenCalledWith({ ...extracted, saveMode: "manual" }, [
      pendingPage.fullText,
    ]);
    expect(chunkWriter.replaceChunksForPage).not.toHaveBeenCalled();
    expect(result).toBe(keywordReadyPage);
  });

  it("tags, embeds, and commits the page atomically", async () => {
    const reader = mockReader({ ...pendingPage, status: "keyword_ready" });
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();

    const result = await new CaptureService(
      { commitCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(reader.claimEnrichment).toHaveBeenCalledWith(pendingPage.id);

    expect(tagger.summarizeAndTag).toHaveBeenCalledWith(
      pendingPage.fullText,
      pendingPage.title,
      pendingPage.url,
      "sk-test",
      pendingPage.contentType,
    );
    expect(embedder.embedBatch).toHaveBeenCalledOnce();
    expect(chunkWriter.commitProcessedPage).toHaveBeenCalledWith(
      pendingPage.id,
      expect.any(Array),
      "mock:embedding",
      { ...taggingResult, status: "ready", enrichmentError: undefined },
      SEMANTIC_INDEX_VERSION,
    );
    expect(reader.updatePage).not.toHaveBeenCalled();
    expect(result.status).toBe("ready");
    expect(result.summary).toBe(taggingResult.summary);
  });

  it("returns a page to keyword_ready when tagging throws, before embedding", async () => {
    const reader = mockReader({ ...pendingPage, status: "keyword_ready" });
    const tagger: PageTagger = {
      summarizeAndTag: vi.fn().mockRejectedValue(new Error("rate_limited")),
    };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();

    const result = await new CaptureService(
      { commitCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(chunkWriter.commitProcessedPage).not.toHaveBeenCalled();
    expect(reader.updatePage).toHaveBeenLastCalledWith(pendingPage.id, {
      status: "keyword_ready",
      enrichmentError: "rate_limited",
    });
    expect(result.status).toBe("keyword_ready");
    expect(result.enrichmentError).toBe("rate_limited");
  });

  it("returns a page to keyword_ready when embedding throws, keeping chunks untouched", async () => {
    const reader = mockReader({ ...pendingPage, status: "keyword_ready" });
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder({
      embedBatch: vi.fn().mockRejectedValue(new Error("network")),
    });

    const result = await new CaptureService(
      { commitCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(chunkWriter.commitProcessedPage).not.toHaveBeenCalled();
    expect(reader.updatePage).toHaveBeenLastCalledWith(pendingPage.id, {
      status: "keyword_ready",
      enrichmentError: "network",
    });
    expect(result.status).toBe("keyword_ready");
  });

  it("marks a page failed when the embedder returns a mismatched vector count", async () => {
    const reader = mockReader({ ...pendingPage, status: "keyword_ready" });
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder({
      embedBatch: vi.fn().mockResolvedValue([]), // zero vectors for >=1 chunk → mismatch
    });

    const result = await new CaptureService(
      { commitCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(chunkWriter.commitProcessedPage).not.toHaveBeenCalled();
    expect(reader.updatePage).toHaveBeenLastCalledWith(pendingPage.id, {
      status: "keyword_ready",
      enrichmentError: expect.stringContaining("mismatch"),
    });
    expect(result.status).toBe("keyword_ready");
  });

  it("reindexes pages sequentially and reports progress", async () => {
    const processed: string[] = [];
    const reader = mockReader({ ...pendingPage, status: "keyword_ready" });
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();
    const service = new CaptureService(
      { commitCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    );
    // Spy processPage to record order without re-tagging twice per id.
    const original = service.processPage.bind(service);
    vi.spyOn(service, "processPage").mockImplementation(async (id, key) => {
      processed.push(id);
      return original(id, key);
    });

    const progress: Array<[number, number]> = [];
    await service.reindexPages(["a", "b", "c"], "sk-test", (done, total) =>
      progress.push([done, total]),
    );

    expect(processed).toEqual(["a", "b", "c"]);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("passes saveMode:'auto' through to the page writer", async () => {
    const extractor: PageExtractor = { extract: vi.fn().mockResolvedValue(extracted) };
    const writer: PageWriter = {
      commitCapturedPage: vi
        .fn()
        .mockResolvedValue({ ...pendingPage, saveMode: "auto", status: "keyword_ready" }),
    };
    const chunkWriter = mockChunkWriter();

    const result = await new CaptureService(
      writer,
      extractor,
      undefined,
      undefined,
      chunkWriter,
    ).save(123, "auto");

    expect(writer.commitCapturedPage).toHaveBeenCalledWith({ ...extracted, saveMode: "auto" }, [
      extracted.fullText,
    ]);
    expect(result.saveMode).toBe("auto");
  });

  it("rebuilds keyword chunks from a failed page's stored full text", async () => {
    const failed = {
      ...pendingPage,
      status: "failed" as const,
      enrichmentError: "local write failed",
    };
    const keywordReady: PageRecord = { ...failed, status: "keyword_ready" };
    delete keywordReady.enrichmentError;
    const writer: PageWriter = {
      commitCapturedPage: vi.fn(),
      retryFailedPage: vi.fn().mockResolvedValue(keywordReady),
    };

    const result = await new CaptureService(
      writer,
      { extract: vi.fn() },
      mockReader(failed),
    ).retryLocalPage(failed.id);

    expect(writer.retryFailedPage).toHaveBeenCalledWith(failed.id, [failed.fullText]);
    expect(result.status).toBe("keyword_ready");
  });

  it("throws when processPage is called for a non-existent page id", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(undefined),
      claimEnrichment: vi.fn().mockRejectedValue(new Error("Page no-such-id not found")),
      updatePage: vi.fn(),
      recoverStaleEnriching: vi.fn(),
    };

    await expect(
      new CaptureService({ commitCapturedPage: vi.fn() }, { extract: vi.fn() }, reader).processPage(
        "no-such-id",
        "sk-test",
      ),
    ).rejects.toThrow("no-such-id");
  });

  it.each(["pending", "enriching", "ready", "failed"] as const)(
    "rejects %s pages before any paid enrichment request",
    async (status) => {
      const reader = mockReader({ ...pendingPage, status });
      const tagger: PageTagger = { summarizeAndTag: vi.fn() };
      const embedder = mockEmbedder();
      const service = new CaptureService(
        { commitCapturedPage: vi.fn() },
        { extract: vi.fn() },
        reader,
        tagger,
        mockChunkWriter(),
        embedder,
      );

      await expect(service.processPage(pendingPage.id, "sk-test")).rejects.toThrow(
        `not eligible for enrichment (${status})`,
      );
      expect(reader.updatePage).not.toHaveBeenCalled();
      expect(tagger.summarizeAndTag).not.toHaveBeenCalled();
      expect(embedder.embedBatch).not.toHaveBeenCalled();
    },
  );

  it("delegates stale enrichment recovery without starting network work", async () => {
    const reader = mockReader();
    vi.mocked(reader.recoverStaleEnriching).mockResolvedValue(2);
    const tagger: PageTagger = { summarizeAndTag: vi.fn() };

    const recovered = await new CaptureService(
      { commitCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
    ).recoverStaleEnriching();

    expect(recovered).toBe(2);
    expect(reader.recoverStaleEnriching).toHaveBeenCalledOnce();
    expect(tagger.summarizeAndTag).not.toHaveBeenCalled();
  });

  it("rebuilds semantic chunks without re-running page enrichment", async () => {
    const readyPage: PageRecord = {
      ...pendingPage,
      status: "ready",
      summary: "Keep this summary",
      topics: ["keep"],
    };
    const reader = mockReader(readyPage);
    const tagger: PageTagger = { summarizeAndTag: vi.fn() };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();
    const service = new CaptureService(
      { commitCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    );

    const result = await service.reindexSemanticPage(readyPage.id, "sk-test");

    expect(tagger.summarizeAndTag).not.toHaveBeenCalled();
    expect(reader.updatePage).not.toHaveBeenCalled();
    expect(chunkWriter.commitProcessedPage).toHaveBeenCalledWith(
      readyPage.id,
      expect.any(Array),
      "mock:embedding",
      { status: "ready" },
      SEMANTIC_INDEX_VERSION,
    );
    expect(result).toBe(readyPage);
  });

  it("leaves page metadata unchanged and throws when semantic re-indexing fails", async () => {
    const readyPage: PageRecord = { ...pendingPage, status: "ready", summary: "Keep me" };
    const reader = mockReader(readyPage);
    const chunkWriter = mockChunkWriter();
    vi.mocked(chunkWriter.commitProcessedPage).mockRejectedValue(new Error("quota"));
    const service = new CaptureService(
      { commitCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      { summarizeAndTag: vi.fn() },
      chunkWriter,
      mockEmbedder(),
    );

    await expect(service.reindexSemanticPage(readyPage.id, "sk-test")).rejects.toThrow("quota");
    expect(reader.updatePage).not.toHaveBeenCalled();
  });

  it("embeds chunks and marks the page ready end-to-end (integration)", async () => {
    const database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    await database.delete();
    await database.open();

    const pageRepo = new PageRepo(database);
    const chunkRepo = new ChunkRepo(database);
    const mock = new MockLLMProvider();

    const fullText =
      "The HorizontalPodAutoscaler automatically scales workloads based on observed CPU metrics.";
    const saved = await pageRepo.commitCapturedPage(
      {
        url: extracted.url,
        title: extracted.title,
        fullText,
        readingTimeMs: 1000,
        saveMode: "manual",
      },
      [fullText],
    );

    const service = new CaptureService(
      pageRepo,
      { extract: vi.fn() },
      pageRepo,
      mock,
      chunkRepo,
      mock,
    );
    const result = await service.processPage(saved.id, "sk-test");

    expect(result.status).toBe("ready");

    const stored = await chunkRepo.allChunks();
    expect(stored.length).toBeGreaterThan(0);
    for (const chunk of stored) {
      expect(ArrayBuffer.isView(chunk.embedding)).toBe(true);
      expect(chunk.embedding?.constructor.name).toBe("Float32Array");
      expect(chunk.embedding?.length).toBe(1536);
      expect(chunk.embeddingModel).toBe("mock:embedding");
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }

    const reread = await pageRepo.getById(saved.id);
    expect(reread?.status).toBe("ready");
    expect(reread?.summary).not.toBe("");
  });
});

describe("mergeFrameExtractions", () => {
  const topFrame: FrameExtraction = {
    frameId: 0,
    page: {
      url: "https://learn.uwaterloo.ca/d2l/le/content/123/viewContent/456",
      title: "FRTF Bridging: Creating a One-Pager Report",
      fullText: "One-Pager Report Loading... Web Page Activity Details",
      readingTimeMs: 10,
    },
  };

  const contentFrame: FrameExtraction = {
    frameId: 7,
    page: {
      url: "https://content.uwaterloo.ca/d2l/iframe/topic.html",
      title: "One-Pager Article",
      fullText:
        "A one-pager is a concise, single-page document that provides a high-level overview. " +
        "It distills complex ideas for a broad audience of stakeholders and investors.",
      readingTimeMs: 25,
    },
  };

  it("keeps the body text from the frame with the most content", () => {
    const result = mergeFrameExtractions([topFrame, contentFrame]);

    expect(result.fullText).toBe(contentFrame.page.fullText);
    expect(result.readingTimeMs).toBe(contentFrame.page.readingTimeMs);
  });

  it("uses the top frame's url and title even when a child frame is richer", () => {
    const result = mergeFrameExtractions([topFrame, contentFrame]);

    expect(result.url).toBe(topFrame.page.url);
    expect(result.title).toBe(topFrame.page.title);
  });

  it("falls back to the richest frame's identity when no top frame is present", () => {
    const result = mergeFrameExtractions([contentFrame]);

    expect(result.url).toBe(contentFrame.page.url);
    expect(result.title).toBe(contentFrame.page.title);
    expect(result.fullText).toBe(contentFrame.page.fullText);
  });

  it("uses a child frame's title when the top frame has no title", () => {
    const titlelessTop: FrameExtraction = {
      frameId: 0,
      page: { ...topFrame.page, title: "" },
    };

    const result = mergeFrameExtractions([titlelessTop, contentFrame]);

    expect(result.title).toBe(contentFrame.page.title);
  });

  it("throws when there are no frame extractions", () => {
    expect(() => mergeFrameExtractions([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ChromePageExtractor
// ---------------------------------------------------------------------------

describe("ChromePageExtractor", () => {
  const tabId = 7;
  const fakeExtracted: ExtractedPage = {
    url: "https://docs.example.com/guide",
    title: "Guide",
    fullText: "Guide content here.",
    readingTimeMs: 5_000,
  };

  beforeEach(() => {
    // Provide a minimal chrome stub visible to the extractor.
    // Each test overrides individual sub-properties as needed.
    (globalThis as Record<string, unknown>)["chrome"] = {
      tabs: {
        sendMessage: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["chrome"];
  });

  it("throws when chrome.tabs.sendMessage is unavailable", async () => {
    (globalThis as Record<string, unknown>)["chrome"] = undefined;

    await expect(new ChromePageExtractor().extract(tabId)).rejects.toThrow(
      "Chrome tabs messaging is unavailable",
    );
  });

  it("extracts from a single top frame and returns the merged page", async () => {
    const chrome = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { sendMessage: ReturnType<typeof vi.fn> };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };

    chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0 }]);
    chrome.tabs.sendMessage.mockResolvedValue({
      type: "content.extracted",
      payload: fakeExtracted,
    });

    const result = await new ChromePageExtractor().extract(tabId);

    expect(result.url).toBe(fakeExtracted.url);
    expect(result.fullText).toBe(fakeExtracted.fullText);
  });

  it("skips frames where sendMessage throws (no content script) and still succeeds", async () => {
    const chrome = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { sendMessage: ReturnType<typeof vi.fn> };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };

    // Two frames — frame 0 fails, frame 1 succeeds
    chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0 }, { frameId: 1 }]);
    chrome.tabs.sendMessage
      .mockRejectedValueOnce(new Error("no content script on frame 0"))
      .mockResolvedValueOnce({ type: "content.extracted", payload: fakeExtracted });

    const result = await new ChromePageExtractor().extract(tabId);

    expect(result.fullText).toBe(fakeExtracted.fullText);
  });

  it("throws when all frames fail to respond", async () => {
    const chrome = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { sendMessage: ReturnType<typeof vi.fn> };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };

    chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0 }]);
    chrome.tabs.sendMessage.mockRejectedValue(new Error("no content script"));

    await expect(new ChromePageExtractor().extract(tabId)).rejects.toThrow(
      "No readable page text found",
    );
  });

  it("ignores frames that return a non-extracted response type", async () => {
    const chrome = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { sendMessage: ReturnType<typeof vi.fn> };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };

    // Frame 0 returns a failure response; frame 1 returns success
    chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0 }, { frameId: 1 }]);
    chrome.tabs.sendMessage
      .mockResolvedValueOnce({ type: "content.extractFailed", payload: { message: "no text" } })
      .mockResolvedValueOnce({ type: "content.extracted", payload: fakeExtracted });

    const result = await new ChromePageExtractor().extract(tabId);

    expect(result.fullText).toBe(fakeExtracted.fullText);
  });

  it("falls back to frame 0 when scripting.executeScript is unavailable", async () => {
    const chrome = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { sendMessage: ReturnType<typeof vi.fn> };
      scripting: { executeScript: ReturnType<typeof vi.fn> } | undefined;
    };

    // Simulate chrome.scripting not available
    chrome.scripting = undefined;
    chrome.tabs.sendMessage.mockResolvedValue({
      type: "content.extracted",
      payload: fakeExtracted,
    });

    const result = await new ChromePageExtractor().extract(tabId);

    expect(result.fullText).toBe(fakeExtracted.fullText);
  });

  it("falls back to frame 0 when scripting.executeScript throws", async () => {
    const chrome = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { sendMessage: ReturnType<typeof vi.fn> };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };

    chrome.scripting.executeScript.mockRejectedValue(new Error("scripting error"));
    chrome.tabs.sendMessage.mockResolvedValue({
      type: "content.extracted",
      payload: fakeExtracted,
    });

    const result = await new ChromePageExtractor().extract(tabId);

    expect(result.fullText).toBe(fakeExtracted.fullText);
  });

  it("falls back to frame 0 when scripting.executeScript returns empty array", async () => {
    const chrome = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { sendMessage: ReturnType<typeof vi.fn> };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };

    chrome.scripting.executeScript.mockResolvedValue([]);
    chrome.tabs.sendMessage.mockResolvedValue({
      type: "content.extracted",
      payload: fakeExtracted,
    });

    const result = await new ChromePageExtractor().extract(tabId);

    expect(result.fullText).toBe(fakeExtracted.fullText);
  });
});
