import { describe, expect, it, vi } from "vitest";

import type { ExtractedPage, PageRecord, TaggingResult } from "../../shared/types";
import { ChunkRepo } from "../repository/ChunkRepo";
import { DevRecallDatabase } from "../repository/db";
import { PageRepo } from "../repository/PageRepo";
import { MockLLMProvider } from "../llm/MockLLMProvider";
import type { Embedder } from "../llm/OpenAIProvider";
import {
  CaptureService,
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
  sourceType: "unknown",
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

const taggingResult: TaggingResult = {
  summary: "HPA autoscales pods based on metrics.",
  sourceType: "official_docs",
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

describe("CaptureService", () => {
  it("extracts the tab, stores a pending page, and writes word chunks", async () => {
    const extractor: PageExtractor = { extract: vi.fn().mockResolvedValue(extracted) };
    const writer: PageWriter = { upsertCapturedPage: vi.fn().mockResolvedValue(pendingPage) };
    const chunkWriter = mockChunkWriter();

    const result = await new CaptureService(
      writer,
      extractor,
      undefined,
      undefined,
      chunkWriter,
    ).save(123);

    expect(extractor.extract).toHaveBeenCalledWith(123);
    expect(writer.upsertCapturedPage).toHaveBeenCalledWith({ ...extracted, saveMode: "manual" });
    expect(chunkWriter.replaceChunksForPage).toHaveBeenCalledWith(pendingPage.id, [
      pendingPage.fullText,
    ]);
    expect(result).toBe(pendingPage);
  });

  it("tags, embeds, and commits the page atomically", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(tagger.summarizeAndTag).toHaveBeenCalledWith(
      pendingPage.fullText,
      pendingPage.title,
      pendingPage.url,
      "sk-test",
    );
    expect(embedder.embedBatch).toHaveBeenCalledOnce();
    expect(chunkWriter.commitProcessedPage).toHaveBeenCalledWith(
      pendingPage.id,
      expect.any(Array),
      "mock:embedding",
      { ...taggingResult, status: "ready" },
    );
    expect(reader.updatePage).not.toHaveBeenCalled();
    expect(result.status).toBe("ready");
    expect(result.summary).toBe(taggingResult.summary);
  });

  it("marks a page failed when tagging throws, before embedding", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = {
      summarizeAndTag: vi.fn().mockRejectedValue(new Error("rate_limited")),
    };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(chunkWriter.commitProcessedPage).not.toHaveBeenCalled();
    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      status: "failed",
      errorReason: "rate_limited",
    });
    expect(result.status).toBe("failed");
  });

  it("marks a page failed when embedding throws, keeping chunks untouched", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder({
      embedBatch: vi.fn().mockRejectedValue(new Error("network")),
    });

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(chunkWriter.commitProcessedPage).not.toHaveBeenCalled();
    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      status: "failed",
      errorReason: "network",
    });
    expect(result.status).toBe("failed");
  });

  it("marks a page failed when the embedder returns a mismatched vector count", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder({
      embedBatch: vi.fn().mockResolvedValue([]), // zero vectors for >=1 chunk → mismatch
    });

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(chunkWriter.commitProcessedPage).not.toHaveBeenCalled();
    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      status: "failed",
      errorReason: expect.stringContaining("mismatch"),
    });
    expect(result.status).toBe("failed");
  });

  it("reindexes pages sequentially and reports progress", async () => {
    const processed: string[] = [];
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();
    const service = new CaptureService(
      { upsertCapturedPage: vi.fn() },
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

  it("embeds chunks and marks the page ready end-to-end (integration)", async () => {
    const database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    await database.delete();
    await database.open();

    const pageRepo = new PageRepo(database);
    const chunkRepo = new ChunkRepo(database);
    const mock = new MockLLMProvider();

    const saved = await pageRepo.upsertCapturedPage({
      url: extracted.url,
      title: extracted.title,
      fullText:
        "The HorizontalPodAutoscaler automatically scales workloads based on observed CPU metrics.",
      readingTimeMs: 1000,
      saveMode: "manual",
    });

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
