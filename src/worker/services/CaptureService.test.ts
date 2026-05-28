import { describe, expect, it, vi } from "vitest";

import type { ExtractedPage, PageRecord, TaggingResult } from "../../shared/types";
import {
  CaptureService,
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

describe("CaptureService", () => {
  it("extracts the tab and stores a pending page", async () => {
    const extractor: PageExtractor = {
      extract: vi.fn().mockResolvedValue(extracted),
    };
    const writer: PageWriter = {
      upsertCapturedPage: vi.fn().mockResolvedValue(pendingPage),
    };

    const result = await new CaptureService(writer, extractor).save(123);

    expect(extractor.extract).toHaveBeenCalledWith(123);
    expect(writer.upsertCapturedPage).toHaveBeenCalledWith({
      ...extracted,
      saveMode: "manual",
    });
    expect(result).toBe(pendingPage);
  });

  it("enriches a pending page with LLM tagging", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = {
      summarizeAndTag: vi.fn().mockResolvedValue(taggingResult),
    };

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
    ).processPage(pendingPage.id, "sk-test");

    expect(tagger.summarizeAndTag).toHaveBeenCalledWith(
      pendingPage.fullText,
      pendingPage.title,
      pendingPage.url,
      "sk-test",
    );
    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      ...taggingResult,
      status: "ready",
    });
    expect(result.status).toBe("ready");
    expect(result.summary).toBe(taggingResult.summary);
  });

  it("marks a page as failed when LLM tagging throws", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = {
      summarizeAndTag: vi.fn().mockRejectedValue(new Error("rate_limited")),
    };

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
    ).processPage(pendingPage.id, "sk-test");

    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      status: "failed",
      errorReason: "rate_limited",
    });
    expect(result.status).toBe("failed");
    expect(result.errorReason).toBe("rate_limited");
  });
});
