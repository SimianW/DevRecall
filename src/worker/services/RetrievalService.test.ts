import { describe, expect, it, vi } from "vitest";

import { Platform, ContentType } from "../../shared/enums";
import type { ChunkRecord, PageRecord, PageStatus } from "../../shared/types";
import type { Embedder } from "../llm/OpenAIProvider";
import type { ApiKeyStore } from "../settings/ApiKeyStore";
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

function page(id: string, title: string, domain: string, status: PageStatus = "ready"): PageRecord {
  return {
    id,
    url: `https://${domain}/${id}`,
    urlHash: id.padEnd(64, "0"),
    title,
    domain,
    platform: Platform.Web,
    contentType: ContentType.Documentation,
    summary: "",
    topics: ["kubernetes"],
    technologies: ["Kubernetes"],
    intent: "reference",
    fullText: "",
    savedAt: 100,
    visitedAt: 100,
    readingTimeMs: 1000,
    saveMode: "manual",
    status,
    schemaVersion: 1,
  };
}

const pages = new Map<string, PageRecord>([
  ["p1", page("p1", "Horizontal Pod Autoscaling", "kubernetes.io")],
  [
    "p2",
    {
      ...page("p2", "React hydration", "github.com"),
      platform: Platform.Github,
      contentType: ContentType.Repository,
    },
  ],
]);

// Keyword-only chunks (no embeddings), as the keyword-first capture writes them.
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

function failingEmbedder(): Embedder {
  return {
    embeddingModel: "fake",
    embed: vi.fn().mockRejectedValue(new Error("embeddings API unavailable")),
    embedBatch: vi.fn(),
  };
}

function fakeKeyStore(apiKey: string | null = "sk-test"): Pick<ApiKeyStore, "getApiKey"> {
  return { getApiKey: vi.fn().mockResolvedValue(apiKey) };
}

function makeService(
  testChunks: ChunkRecord[] = keywordChunks,
  embedder: Embedder = fakeEmbedder({}),
  apiKey: string | null = "sk-test",
  pageRecords: Map<string, PageRecord> = pages,
  apiKeyStore: Pick<ApiKeyStore, "getApiKey"> = fakeKeyStore(apiKey),
): RetrievalService {
  const chunkSource: ChunkSource = { allChunks: vi.fn().mockResolvedValue(testChunks) };
  const pageSource: PageSource = {
    getById: vi.fn().mockImplementation((id: string) => pageRecords.get(id)),
  };
  return new RetrievalService(chunkSource, pageSource, embedder, apiKeyStore);
}

describe("RetrievalService search modes", () => {
  it('effectiveMode "local" runs BM25 only and reports searchMode "local"', async () => {
    const embedder = fakeEmbedder({ "autoscaler pods": [1, 0] });
    const apiKeyStore = fakeKeyStore();

    const outcome = await makeService(vectorChunks, embedder, "sk-test", pages, apiKeyStore).search(
      {
        query: "autoscaler pods",
        effectiveMode: "local",
      },
    );

    expect(outcome.searchMode).toBe("local");
    expect(apiKeyStore.getApiKey).not.toHaveBeenCalled();
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].page.id).toBe("p1");
    expect(outcome.results[0].matchReason).toBe("keyword");
    expect(outcome.results[0].scores.keyword).toBeGreaterThan(0);
    expect(outcome.results[0].scores.vector).toBeNull();
  });

  it('effectiveMode "hybrid" fuses both arms and reports searchMode "hybrid"', async () => {
    const embedder = fakeEmbedder({ autoscaler: [1, 0] });

    const outcome = await makeService(vectorChunks, embedder).search({
      query: "autoscaler",
      effectiveMode: "hybrid",
    });

    expect(outcome.searchMode).toBe("hybrid");
    expect(embedder.embed).toHaveBeenCalledWith("autoscaler", "sk-test");
    expect(outcome.results[0].page.id).toBe("p1");
    expect(outcome.results[0].matchReason).toBe("both");
    expect(outcome.results[0].scores.keyword).toBeGreaterThan(0);
    expect(outcome.results[0].scores.vector).toBeGreaterThan(0.9);
    expect(outcome.results[0].bestChunk.highlightedHtml).toContain("<mark>autoscaler</mark>");
  });

  it("hybrid degrades to keyword_fallback (instead of throwing) when the embed call fails", async () => {
    const embedder = failingEmbedder();

    const outcome = await makeService(vectorChunks, embedder).search({
      query: "autoscaler pods",
      effectiveMode: "hybrid",
    });

    expect(outcome.searchMode).toBe("keyword_fallback");
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].page.id).toBe("p1");
    expect(outcome.results[0].matchReason).toBe("keyword");
    expect(outcome.results[0].scores.keyword).toBeGreaterThan(0);
    expect(outcome.results[0].scores.vector).toBeNull();
    expect(embedder.embed).toHaveBeenCalledTimes(1);
  });

  it("hybrid degrades to keyword_fallback when the API key disappeared after mode resolution", async () => {
    const embedder = fakeEmbedder({ autoscaler: [1, 0] });

    const outcome = await makeService(vectorChunks, embedder, null).search({
      query: "autoscaler",
      effectiveMode: "hybrid",
    });

    expect(outcome.searchMode).toBe("keyword_fallback");
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(outcome.results[0].matchReason).toBe("keyword");
  });

  it.each(["local", "hybrid"] as const)(
    "returns an empty result for a blank query and echoes the requested mode (%s)",
    async (effectiveMode) => {
      const outcome = await makeService().search({ query: "   ", effectiveMode });

      expect(outcome).toEqual({ results: [], searchMode: effectiveMode });
    },
  );

  it("returns an empty outcome for an empty corpus without calling the embedder", async () => {
    const embedder = fakeEmbedder({});

    const outcome = await makeService([], embedder).search({
      query: "autoscaler",
      effectiveMode: "hybrid",
    });

    expect(outcome).toEqual({ results: [], searchMode: "hybrid" });
    expect(embedder.embed).not.toHaveBeenCalled();
  });
});

describe("RetrievalService status filter", () => {
  const statusPages = new Map<string, PageRecord>([
    ["pen", page("pen", "Pending page", "docs.example", "pending")],
    ["kready", page("kready", "Keyword-ready page", "docs.example", "keyword_ready")],
    ["enrich", page("enrich", "Enriching page", "docs.example", "enriching")],
    ["rdy", page("rdy", "Ready page", "docs.example", "ready")],
    ["fai", page("fai", "Failed page", "docs.example", "failed")],
  ]);

  const statusChunks = [
    chunk("s-pen", "pen", 0, "prometheus alert rules captured just now"),
    chunk("s-kready", "kready", 0, "prometheus alert rules keyword indexed"),
    chunk("s-enrich", "enrich", 0, "prometheus alert rules enriching now"),
    chunk("s-rdy", "rdy", 0, "prometheus alert rules fully enriched"),
    chunk("s-fai", "fai", 0, "prometheus alert rules enrichment failed"),
  ];

  it("searches only keyword_ready, enriching, and ready pages", async () => {
    const outcome = await makeService(
      statusChunks,
      fakeEmbedder({}),
      "sk-test",
      statusPages,
    ).search({ query: "prometheus alert rules", effectiveMode: "local" });

    expect(outcome.results.map((hit) => hit.page.id).sort()).toEqual(["enrich", "kready", "rdy"]);
  });

  it("skips a failed page without losing a topK slot to it", async () => {
    // The failed page's chunk is the strongest BM25 match (highest tf), so a
    // slice-then-filter implementation would return 0 of the requested 1 hits.
    const rankPages = new Map<string, PageRecord>([
      ["fai", page("fai", "Failed page", "docs.example", "failed")],
      ["rdy", page("rdy", "Ready page", "docs.example", "ready")],
    ]);
    const rankChunks = [
      chunk("r-fai", "fai", 0, "autoscaler autoscaler autoscaler"),
      chunk("r-rdy", "rdy", 0, "autoscaler"),
    ];

    const outcome = await makeService(rankChunks, fakeEmbedder({}), "sk-test", rankPages).search({
      query: "autoscaler",
      topK: 1,
      effectiveMode: "local",
    });

    expect(outcome.searchMode).toBe("local");
    expect(outcome.results.map((hit) => hit.page.id)).toEqual(["rdy"]);
  });
});

describe("RetrievalService vector threshold", () => {
  it("filters out vector results below the similarity threshold", async () => {
    // c1 has embedding [1, 0]; query [0, 1] → cosine similarity = 0 → below threshold
    const lowSimChunks = [chunk("c1", "p1", 0, "horizontal pod autoscaler", [1, 0])];
    const embedder = fakeEmbedder({ "perpendicular query": [0, 1] });
    const chunkSource: ChunkSource = { allChunks: vi.fn().mockResolvedValue(lowSimChunks) };
    const pageSource: PageSource = {
      getById: vi.fn().mockImplementation((id: string) => pages.get(id)),
    };
    const service = new RetrievalService(chunkSource, pageSource, embedder, fakeKeyStore());

    const outcome = await service.search({ query: "perpendicular query", effectiveMode: "hybrid" });

    expect(outcome).toEqual({ results: [], searchMode: "hybrid" });
  });
});

describe("RetrievalService caching", () => {
  function countingService() {
    const allChunks = vi.fn().mockResolvedValue(keywordChunks);
    const chunkSource: ChunkSource = { allChunks };
    const pageSource: PageSource = {
      getById: vi.fn().mockImplementation((id: string) => pages.get(id)),
    };
    return {
      service: new RetrievalService(chunkSource, pageSource, fakeEmbedder({}), fakeKeyStore()),
      allChunks,
    };
  }

  it("loads chunks once across distinct queries, reloads after invalidate", async () => {
    const { service, allChunks } = countingService();

    await service.search({ query: "autoscaler", effectiveMode: "local" });
    await service.search({ query: "hydration", effectiveMode: "local" });
    expect(allChunks).toHaveBeenCalledTimes(1);

    service.invalidate();
    await service.search({ query: "autoscaler", effectiveMode: "local" });
    expect(allChunks).toHaveBeenCalledTimes(2);
  });

  it("returns the cached outcome object for a repeated query", async () => {
    const { service, allChunks } = countingService();

    const first = await service.search({ query: "autoscaler pods", effectiveMode: "local" });
    const second = await service.search({ query: "autoscaler pods", effectiveMode: "local" });

    expect(second).toBe(first); // same reference from the query cache
    expect(allChunks).toHaveBeenCalledTimes(1);
  });

  it("caches per mode — the same query reruns under a different effective mode", async () => {
    const { service } = countingService();

    const local = await service.search({ query: "autoscaler", effectiveMode: "local" });
    const hybrid = await service.search({ query: "autoscaler", effectiveMode: "hybrid" });

    expect(hybrid).not.toBe(local);
    expect(local.searchMode).toBe("local");
    expect(hybrid.searchMode).toBe("hybrid");
  });

  it("does not cache a fallback, so a later hybrid search can recover", async () => {
    const embedder = fakeEmbedder({ "autoscaler pods": [1, 0] });
    vi.mocked(embedder.embed)
      .mockRejectedValueOnce(new Error("embeddings API unavailable"))
      .mockResolvedValueOnce(Float32Array.from([1, 0]));
    const service = makeService(vectorChunks, embedder);

    const first = await service.search({ query: "autoscaler pods", effectiveMode: "hybrid" });
    const second = await service.search({ query: "autoscaler pods", effectiveMode: "hybrid" });

    expect(first.searchMode).toBe("keyword_fallback");
    expect(second.searchMode).toBe("hybrid");
    expect(second).not.toBe(first);
    expect(embedder.embed).toHaveBeenCalledTimes(2);
  });

  it("reads the latest key before every uncached hybrid attempt", async () => {
    const getApiKey = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("sk-new");
    const apiKeyStore = { getApiKey };
    const embedder = fakeEmbedder({ autoscaler: [1, 0] });
    const service = makeService(vectorChunks, embedder, null, pages, apiKeyStore);

    const first = await service.search({ query: "autoscaler", effectiveMode: "hybrid" });
    const second = await service.search({ query: "autoscaler", effectiveMode: "hybrid" });

    expect(first.searchMode).toBe("keyword_fallback");
    expect(second.searchMode).toBe("hybrid");
    expect(getApiKey).toHaveBeenCalledTimes(2);
    expect(embedder.embed).toHaveBeenCalledWith("autoscaler", "sk-new");
  });

  it("drops cached query results on invalidate", async () => {
    const { service, allChunks } = countingService();

    const first = await service.search({ query: "autoscaler pods", effectiveMode: "local" });
    service.invalidate();
    const second = await service.search({ query: "autoscaler pods", effectiveMode: "local" });

    expect(second).not.toBe(first);
    expect(allChunks).toHaveBeenCalledTimes(2);
  });
});

describe("RetrievalService keyword arm", () => {
  it("returns the best-matching page with a highlighted chunk", async () => {
    const outcome = await makeService().search({ query: "autoscale pods", effectiveMode: "local" });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].page.id).toBe("p1");
    expect(outcome.results[0].matchReason).toBe("keyword");
    expect(outcome.results[0].scores.keyword).toBeGreaterThan(0);
    expect(outcome.results[0].scores.vector).toBeNull();
    expect(outcome.results[0].scores.fused).toBeGreaterThan(0);
    expect(outcome.results[0].bestChunk.highlightedHtml).toContain("<mark>pods</mark>");
  });

  it("keeps only the highest-scoring chunk per page", async () => {
    const outcome = await makeService().search({
      query: "autoscaler pods",
      effectiveMode: "local",
    });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].bestChunk.ordinal).toBe(0);
  });

  it("honors the topK option", async () => {
    const outcome = await makeService().search({
      query: "autoscaler hydration",
      topK: 1,
      effectiveMode: "local",
    });

    expect(outcome.results).toHaveLength(1);
  });

  it("surfaces a vector-only hit that keyword search misses (matched by meaning)", async () => {
    // "distributed memory cache" has no stemmed token overlap with any chunk
    // (distribut/memori/cach do not appear in chunks), so the keyword arm misses.
    const embedder = fakeEmbedder({ "distributed memory cache": [1, 0] });

    // Local mode finds nothing — none of these stems appear in any chunk.
    const local = await makeService(vectorChunks, embedder).search({
      query: "distributed memory cache",
      effectiveMode: "local",
    });
    expect(local).toEqual({ results: [], searchMode: "local" });

    // Hybrid mode surfaces p1 by meaning, with no literal term overlap.
    const hybrid = await makeService(vectorChunks, embedder).search({
      query: "distributed memory cache",
      effectiveMode: "hybrid",
    });

    expect(hybrid.searchMode).toBe("hybrid");
    expect(hybrid.results[0].page.id).toBe("p1");
    expect(hybrid.results[0].matchReason).toBe("vector");
    expect(hybrid.results[0].scores.keyword).toBeNull();
    expect(hybrid.results[0].scores.vector).toBeGreaterThan(0.9);
    expect(hybrid.results[0].bestChunk.highlightedHtml).not.toContain("<mark>");
    expect(embedder.embed).toHaveBeenCalledWith("distributed memory cache", "sk-test");
  });

  it("runs the vector arm in hybrid mode even when chunks have no embeddings", async () => {
    const embedder = fakeEmbedder({ "autoscaler pods": [1, 0] });

    // keywordChunks have no embeddings; the vector arm runs but cosineTopK skips them all.
    const outcome = await makeService(keywordChunks, embedder).search({
      query: "autoscaler pods",
      effectiveMode: "hybrid",
    });

    // The embed call succeeded, so this is a genuine hybrid outcome, not a fallback.
    expect(outcome.searchMode).toBe("hybrid");
    expect(outcome.results[0].matchReason).toBe("keyword");
    expect(outcome.results[0].scores.vector).toBeNull();
    expect(embedder.embed).toHaveBeenCalled();
  });
});
