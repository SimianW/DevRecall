import { describe, expect, it, vi } from "vitest";

import type { ExtractedPage, PageRecord } from "../../shared/types";
import { CaptureService, type PageExtractor, type PageWriter } from "./CaptureService";

describe("CaptureService", () => {
  it("extracts the tab and stores a manual page", async () => {
    const extracted: ExtractedPage = {
      url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      title: "Horizontal Pod Autoscaling",
      fullText: "Autoscaling docs",
      readingTimeMs: 30_000,
    };
    const page = {
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
      status: "ready",
      schemaVersion: 1,
    } satisfies PageRecord;
    const extractor: PageExtractor = {
      extract: vi.fn().mockResolvedValue(extracted),
    };
    const writer: PageWriter = {
      upsertCapturedPage: vi.fn().mockResolvedValue(page),
    };

    const result = await new CaptureService(writer, extractor).save(123);

    expect(extractor.extract).toHaveBeenCalledWith(123);
    expect(writer.upsertCapturedPage).toHaveBeenCalledWith({
      ...extracted,
      saveMode: "manual",
    });
    expect(result).toBe(page);
  });
});
