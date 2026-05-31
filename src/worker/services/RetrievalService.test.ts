import { describe, expect, it, vi } from "vitest";

import type { ChunkRecord, PageRecord } from "../../shared/types";
import { RetrievalService, type ChunkSource, type PageSource } from "./RetrievalService";

function chunk(id: string, pageId: string, ordinal: number, text: string): ChunkRecord {
  return { id, pageId, ordinal, text, schemaVersion: 1 };
}

function page(id: string, title: string, domain: string): PageRecord {
  return {
    id,
    url: `https://${domain}/${id}`,
    urlHash: id.padEnd(64, "0"),
    title,
    domain,
    sourceType: "official_docs",
    summary: "",
    topics: ["kubernetes"],
    technologies: ["Kubernetes"],
    intent: "reference",
    fullText: "",
    savedAt: 100,
    visitedAt: 100,
    readingTimeMs: 1000,
    saveMode: "manual",
    status: "ready",
    schemaVersion: 1,
  };
}

const chunks = [
  chunk("c1", "p1", 0, "horizontal pod autoscaler automatically scales pods"),
  chunk("c2", "p2", 0, "react hydration mismatch during rendering"),
  chunk("c3", "p1", 1, "the autoscaler watches metrics"),
];

const pages = new Map<string, PageRecord>([
  ["p1", page("p1", "Horizontal Pod Autoscaling", "kubernetes.io")],
  ["p2", page("p2", "React hydration", "github.com")],
]);

function makeService(): RetrievalService {
  const chunkSource: ChunkSource = {
    allChunks: vi.fn().mockResolvedValue(chunks),
  };
  const pageSource: PageSource = {
    getById: vi.fn().mockImplementation((id: string) => pages.get(id)),
  };

  return new RetrievalService(chunkSource, pageSource);
}

describe("RetrievalService", () => {
  it("returns an empty array for a blank query", async () => {
    await expect(makeService().search("   ")).resolves.toEqual([]);
  });

  it("returns the best-matching page with a highlighted chunk", async () => {
    const hits = await makeService().search("autoscale pods");

    expect(hits).toHaveLength(1);
    expect(hits[0].page.id).toBe("p1");
    expect(hits[0].page.title).toBe("Horizontal Pod Autoscaling");
    expect(hits[0].matchReason).toBe("keyword");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].bestChunk.highlightedHtml).toContain("<mark>pods</mark>");
  });

  it("keeps only the highest-scoring chunk per page", async () => {
    const hits = await makeService().search("autoscaler pods");

    expect(hits).toHaveLength(1);
    expect(hits[0].bestChunk.ordinal).toBe(0);
  });

  it("honors the topK option", async () => {
    const hits = await makeService().search("autoscaler hydration", {
      topK: 1,
    });

    expect(hits).toHaveLength(1);
  });
});
