import { describe, expect, it, vi } from "vitest";

import type { ChunkRecord, PageRecord } from "../../shared/types";
import type { Embedder } from "../llm/OpenAIProvider";
import { RetrievalService, type ChunkSource, type PageSource } from "./RetrievalService";

function chunk(
  id: string,
  pageId: string,
  ordinal: number,
  text: string,
  embedding?: number[],
): ChunkRecord {
  return {
    id,
    pageId,
    ordinal,
    text,
    ...(embedding ? { embedding: Float32Array.from(embedding) } : {}),
    schemaVersion: 1,
  };
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

const pages = new Map<string, PageRecord>([
  ["p1", page("p1", "Horizontal Pod Autoscaling", "kubernetes.io")],
  ["p2", page("p2", "React hydration", "github.com")],
]);

// Keyword-only chunks (no embeddings), as M4 produced them.
const keywordChunks = [
  chunk("c1", "p1", 0, "horizontal pod autoscaler automatically scales pods"),
  chunk("c2", "p2", 0, "react hydration mismatch during rendering"),
  chunk("c3", "p1", 1, "the autoscaler watches metrics"),
];

// Chunks with hand-crafted unit embeddings for the vector arm.
const vectorChunks = [
  chunk("c1", "p1", 0, "horizontal pod autoscaler scales pods", [1, 0]),
  chunk("c2", "p2", 0, "react server side rendering hydration", [0, 1]),
];

function fakeEmbedder(queryVectors: Record<string, number[]>): Embedder {
  return {
    embeddingModel: "fake",
    embed: vi
      .fn()
      .mockImplementation(async (text: string) => Float32Array.from(queryVectors[text] ?? [0, 0])),
    embedBatch: vi.fn(),
  };
}

function makeService(
  testChunks: ChunkRecord[] = keywordChunks,
  embedder: Embedder = fakeEmbedder({}),
): RetrievalService {
  const chunkSource: ChunkSource = { allChunks: vi.fn().mockResolvedValue(testChunks) };
  const pageSource: PageSource = {
    getById: vi.fn().mockImplementation((id: string) => pages.get(id)),
  };
  return new RetrievalService(chunkSource, pageSource, embedder);
}

describe("RetrievalService", () => {
  it("returns an empty array for a blank query", async () => {
    await expect(makeService().search("   ")).resolves.toEqual([]);
  });

  it("returns the best-matching page with a highlighted chunk (keyword arm)", async () => {
    const hits = await makeService().search("autoscale pods");

    expect(hits).toHaveLength(1);
    expect(hits[0].page.id).toBe("p1");
    expect(hits[0].matchReason).toBe("keyword");
    expect(hits[0].scores.keyword).toBeGreaterThan(0);
    expect(hits[0].scores.vector).toBeNull();
    expect(hits[0].scores.fused).toBeGreaterThan(0);
    expect(hits[0].bestChunk.highlightedHtml).toContain("<mark>pods</mark>");
  });

  it("keeps only the highest-scoring chunk per page", async () => {
    const hits = await makeService().search("autoscaler pods");

    expect(hits).toHaveLength(1);
    expect(hits[0].bestChunk.ordinal).toBe(0);
  });

  it("honors the topK option", async () => {
    const hits = await makeService().search("autoscaler hydration", { topK: 1 });

    expect(hits).toHaveLength(1);
  });

  it("does not call the embedder without an API key", async () => {
    const embedder = fakeEmbedder({});

    await makeService(vectorChunks, embedder).search("autoscaler pods");

    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it("surfaces a vector-only hit that keyword search misses (matched by meaning)", async () => {
    const embedder = fakeEmbedder({ "elastic scaling of containers": [1, 0] });

    // Keyword-only (no key) finds nothing — none of these terms appear in any chunk.
    const keywordOnly = await makeService(vectorChunks, embedder).search(
      "elastic scaling of containers",
    );
    expect(keywordOnly).toEqual([]);

    // Hybrid (with key) surfaces p1 by meaning, with no literal term overlap.
    const hybrid = await makeService(vectorChunks, embedder).search(
      "elastic scaling of containers",
      { apiKey: "sk-test" },
    );

    expect(hybrid[0].page.id).toBe("p1");
    expect(hybrid[0].matchReason).toBe("vector");
    expect(hybrid[0].scores.keyword).toBeNull();
    expect(hybrid[0].scores.vector).toBeGreaterThan(0.9);
    expect(hybrid[0].bestChunk.highlightedHtml).not.toContain("<mark>");
    expect(embedder.embed).toHaveBeenCalledWith("elastic scaling of containers", "sk-test");
  });

  it("fuses keyword and vector arms into a 'both' match", async () => {
    const embedder = fakeEmbedder({ autoscaler: [1, 0] });

    const hits = await makeService(vectorChunks, embedder).search("autoscaler", {
      apiKey: "sk-test",
    });

    expect(hits[0].page.id).toBe("p1");
    expect(hits[0].matchReason).toBe("both");
    expect(hits[0].scores.keyword).toBeGreaterThan(0);
    expect(hits[0].scores.vector).toBeGreaterThan(0.9);
    expect(hits[0].bestChunk.highlightedHtml).toContain("<mark>autoscaler</mark>");
  });

  it("degrades to keyword-only when chunks have no embeddings", async () => {
    const embedder = fakeEmbedder({ "autoscaler pods": [1, 0] });

    // keywordChunks have no embeddings; the vector arm runs but cosineTopK skips them all.
    const hits = await makeService(keywordChunks, embedder).search("autoscaler pods", {
      apiKey: "sk-test",
    });

    expect(hits[0].matchReason).toBe("keyword");
    expect(hits[0].scores.vector).toBeNull();
    expect(embedder.embed).toHaveBeenCalled();
  });
});
