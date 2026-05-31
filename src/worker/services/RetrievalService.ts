import { bm25Search } from "../../lib/bm25";
import { highlightTerms } from "../../lib/highlight";
import { matchReasonFor, reciprocalRankFusion } from "../../lib/rrf";
import { cosineTopK } from "../../lib/vector";
import type { ChunkRecord, PageHit, PageRecord } from "../../shared/types";
import { OpenAIProvider, type Embedder } from "../llm/OpenAIProvider";
import { ChunkRepo } from "../repository/ChunkRepo";
import { PageRepo, toPageListItem } from "../repository/PageRepo";

export type ChunkSource = {
  allChunks(): Promise<ChunkRecord[]>;
};

export type PageSource = {
  getById(id: string): Promise<PageRecord | undefined>;
};

export type SearchOptions = {
  topK?: number;
  apiKey?: string | null;
};

const DEFAULT_TOP_K = 10;
const VECTOR_TOP_K = 50;
const MAX_QUERY_CACHE = 20;
// Minimum cosine similarity to include a vector hit. 0.4 blocks true gibberish
// (orthogonal vectors → similarity 0) while allowing morphological variants
// like "reporting" → "report" that BM25 misses without stemming.
const MIN_VECTOR_SCORE = 0.4;

type FusedChunk = {
  chunk: ChunkRecord;
  fused: number;
  keyword: number | null;
  vector: number | null;
  matchReason: PageHit["matchReason"];
  matchedTerms: string[];
};

export class RetrievalService {
  private chunkCache: ChunkRecord[] | null = null;
  private readonly queryCache = new Map<string, PageHit[]>();

  constructor(
    private readonly chunks: ChunkSource = new ChunkRepo(),
    private readonly pages: PageSource = new PageRepo(),
    private readonly embedder: Embedder = new OpenAIProvider(),
  ) {}

  /** Clears the in-memory chunk array and the query cache. Called on any page change. */
  invalidate(): void {
    this.chunkCache = null;
    this.queryCache.clear();
  }

  async search(query: string, options: SearchOptions = {}): Promise<PageHit[]> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const apiKey = options.apiKey ?? null;
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const cacheKey = `${apiKey ? "k" : "n"}|${topK}|${trimmed.toLowerCase()}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      // LRU touch: re-insert to mark most-recently-used.
      this.queryCache.delete(cacheKey);
      this.queryCache.set(cacheKey, cached);
      return cached;
    }

    const results = await this.computeSearch(trimmed, topK, apiKey);

    this.queryCache.set(cacheKey, results);
    if (this.queryCache.size > MAX_QUERY_CACHE) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) {
        this.queryCache.delete(oldest);
      }
    }

    return results;
  }

  private async loadChunks(): Promise<ChunkRecord[]> {
    if (this.chunkCache === null) {
      this.chunkCache = await this.chunks.allChunks();
    }
    return this.chunkCache;
  }

  private async computeSearch(
    trimmed: string,
    topK: number,
    apiKey: string | null,
  ): Promise<PageHit[]> {
    const allChunks = await this.loadChunks();

    if (allChunks.length === 0) {
      return [];
    }

    // Keyword arm — BM25-lite over every chunk's text (CJK-aware tokenizer).
    const keywordScore = new Map<string, number>();
    const matchedTerms = new Map<string, string[]>();
    const keywordRanking: string[] = [];
    for (const hit of bm25Search(
      trimmed,
      allChunks.map((c) => c.text),
    )) {
      const id = allChunks[hit.index].id;
      keywordRanking.push(id);
      keywordScore.set(id, hit.score);
      matchedTerms.set(id, hit.matchedTerms);
    }

    // Vector arm — only with an API key; chunks lacking an embedding drop out.
    const vectorScore = new Map<string, number>();
    const vectorRanking: string[] = [];
    if (apiKey) {
      try {
        const queryVector = await this.embedder.embed(trimmed, apiKey);
        for (const hit of cosineTopK(queryVector, allChunks, VECTOR_TOP_K)) {
          if (hit.score < MIN_VECTOR_SCORE) break; // results are sorted desc, can break early
          const id = allChunks[hit.index].id;
          vectorRanking.push(id);
          vectorScore.set(id, hit.score);
        }
      } catch {
        // Vector-arm failure (e.g. an embed error) degrades to keyword-only.
      }
    }

    const fused = reciprocalRankFusion(keywordRanking, vectorRanking);

    if (fused.size === 0) {
      return [];
    }

    const chunkById = new Map(allChunks.map((c): [string, ChunkRecord] => [c.id, c]));

    const bestByPage = new Map<string, FusedChunk>();
    for (const [id, entry] of fused) {
      const chunk = chunkById.get(id);
      if (!chunk) {
        continue;
      }

      const candidate: FusedChunk = {
        chunk,
        fused: entry.fused,
        keyword: keywordScore.get(id) ?? null,
        vector: vectorScore.get(id) ?? null,
        matchReason: matchReasonFor(entry),
        matchedTerms: matchedTerms.get(id) ?? [],
      };

      const current = bestByPage.get(chunk.pageId);
      if (!current || candidate.fused > current.fused) {
        bestByPage.set(chunk.pageId, candidate);
      }
    }

    const ranked = Array.from(bestByPage.values())
      .sort((left, right) => right.fused - left.fused)
      .slice(0, topK);

    const results: PageHit[] = [];
    for (const entry of ranked) {
      const page = await this.pages.getById(entry.chunk.pageId);
      if (!page) {
        continue;
      }

      results.push({
        page: toPageListItem(page),
        bestChunk: {
          text: entry.chunk.text,
          ordinal: entry.chunk.ordinal,
          highlightedHtml: highlightTerms(entry.chunk.text, entry.matchedTerms),
        },
        scores: { keyword: entry.keyword, vector: entry.vector, fused: entry.fused },
        matchReason: entry.matchReason,
      });
    }

    return results;
  }
}
