import { bm25Search } from "../../lib/bm25";
import { highlightTerms } from "../../lib/highlight";
import { matchReasonFor, reciprocalRankFusion } from "../../lib/rrf";
import { cosineTopK } from "../../lib/vector";
import type { EffectiveMode, SearchMode } from "../../shared/modes";
import type { ChunkRecord, PageHit, PageRecord } from "../../shared/types";
import { OpenAIProvider, type Embedder } from "../llm/OpenAIProvider";
import { ChunkRepo } from "../repository/ChunkRepo";
import { PageRepo, toPageListItem } from "../repository/PageRepo";
import { ChromeApiKeyStore, type ApiKeyStore } from "../settings/ApiKeyStore";

export type ChunkSource = {
  allChunks(): Promise<ChunkRecord[]>;
};

export type PageSource = {
  getById(id: string): Promise<PageRecord | undefined>;
};

export type SearchInput = {
  query: string;
  topK?: number;
  /**
   * The mode resolved for this query. Local never reads the API key or touches
   * the embedder. Hybrid runs both retrieval arms when the key is still usable.
   */
  effectiveMode: EffectiveMode;
  resolveEffectiveMode?: () => Promise<EffectiveMode>;
};

export type SearchOutcome = {
  results: PageHit[];
  /** The mode that actually ran. Hybrid degrades to "keyword_fallback" on embed failure. */
  searchMode: SearchMode;
};

const DEFAULT_TOP_K = 10;
const VECTOR_TOP_K = 50;
const MAX_QUERY_CACHE = 20;
// M6 Task 5: re-measured post-stemming (text-embedding-3-small, 2026-06).
// The [0.30, 0.40) band only contains "hyperlinks" (0.384) — a peripheral
// keyword already recalled by the BM25 arm, so admitting it via vector is
// neutral. Genuine paraphrases ("tiny fraction of users" 0.267, "reporting"
// 0.275) fall below 0.3; "reporting" is now covered by Task 1 stemming anyway.
// Lowering to 0.3 adds false-positive risk with no real recall gain.
// Decision: keep 0.4 as the high-confidence conceptual gate.
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

type SearchCorpus = {
  chunks: ChunkRecord[];
  pages: Map<string, PageRecord>;
};

const SEARCHABLE_STATUSES = new Set<PageRecord["status"]>(["keyword_ready", "enriching", "ready"]);

export class RetrievalService {
  private corpusCache: SearchCorpus | null = null;
  private readonly queryCache = new Map<string, SearchOutcome>();

  constructor(
    private readonly chunks: ChunkSource = new ChunkRepo(),
    private readonly pages: PageSource = new PageRepo(),
    private readonly embedder: Embedder = new OpenAIProvider(),
    private readonly apiKeyStore: Pick<ApiKeyStore, "getApiKey"> = new ChromeApiKeyStore(),
  ) {}

  /** Clears the in-memory corpus and query cache. Called on any page change. */
  invalidate(): void {
    this.corpusCache = null;
    this.queryCache.clear();
  }

  /**
   * Mode-aware search. Never throws for query-side failures: if the hybrid
   * vector arm cannot run (embed error, or the API key disappeared between
   * mode resolution and this query), the keyword results are returned with
   * `searchMode: "keyword_fallback"` instead.
   */
  async search(input: SearchInput): Promise<SearchOutcome> {
    const topK = input.topK ?? DEFAULT_TOP_K;
    const trimmed = input.query.trim();

    if (trimmed.length === 0) {
      return { results: [], searchMode: input.effectiveMode };
    }

    const cacheKey = `${input.effectiveMode}|${topK}|${trimmed.toLowerCase()}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      // LRU touch: re-insert to mark most-recently-used.
      this.queryCache.delete(cacheKey);
      this.queryCache.set(cacheKey, cached);
      return cached;
    }

    const outcome = await this.computeSearch(
      trimmed,
      topK,
      input.effectiveMode,
      input.resolveEffectiveMode,
    );

    // Cache only the mode this request was authorized to run. A fallback or a
    // Hybrid request revoked to Local-only must be recomputed after recovery.
    if (outcome.searchMode === input.effectiveMode) {
      this.queryCache.set(cacheKey, outcome);
      if (this.queryCache.size > MAX_QUERY_CACHE) {
        const oldest = this.queryCache.keys().next().value;
        if (oldest !== undefined) {
          this.queryCache.delete(oldest);
        }
      }
    }

    return outcome;
  }

  private async loadCorpus(): Promise<SearchCorpus> {
    if (this.corpusCache !== null) {
      return this.corpusCache;
    }

    const chunks = await this.chunks.allChunks();
    const pageIds = Array.from(new Set(chunks.map((chunk) => chunk.pageId)));
    const records = await Promise.all(pageIds.map((pageId) => this.pages.getById(pageId)));
    const pages = new Map<string, PageRecord>();

    for (const page of records) {
      if (page && SEARCHABLE_STATUSES.has(page.status)) {
        pages.set(page.id, page);
      }
    }

    this.corpusCache = {
      chunks: chunks.filter((chunk) => pages.has(chunk.pageId)),
      pages,
    };
    return this.corpusCache;
  }

  private async computeSearch(
    trimmed: string,
    topK: number,
    effectiveMode: EffectiveMode,
    resolveEffectiveMode?: () => Promise<EffectiveMode>,
  ): Promise<SearchOutcome> {
    const { chunks: allChunks, pages } = await this.loadCorpus();

    if (allChunks.length === 0) {
      return { results: [], searchMode: effectiveMode };
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

    // Vector arm — hybrid mode only. Any failure (missing key, embed error)
    // degrades the whole query to keyword_fallback rather than throwing.
    const vectorScore = new Map<string, number>();
    const vectorRanking: string[] = [];
    let degraded = false;
    let searchMode: SearchMode = effectiveMode;
    if (effectiveMode === "hybrid") {
      try {
        const latestMode = resolveEffectiveMode ? await resolveEffectiveMode() : effectiveMode;
        if (latestMode === "local") {
          searchMode = "local";
        } else {
          const apiKey = await this.apiKeyStore.getApiKey();
          if (!apiKey) {
            // Mode was resolved against a key that has since been revoked.
            degraded = true;
          } else {
            const maySend = resolveEffectiveMode
              ? async () => (await resolveEffectiveMode()) === "hybrid"
              : undefined;
            const queryVector = maySend
              ? await this.embedder.embed(trimmed, apiKey, maySend)
              : await this.embedder.embed(trimmed, apiKey);
            for (const hit of cosineTopK(queryVector, allChunks, VECTOR_TOP_K)) {
              if (hit.score < MIN_VECTOR_SCORE) break; // results are sorted desc, can break early
              const id = allChunks[hit.index].id;
              vectorRanking.push(id);
              vectorScore.set(id, hit.score);
            }
          }
        }
      } catch {
        const latestMode = resolveEffectiveMode ? await resolveEffectiveMode() : effectiveMode;
        if (latestMode === "local") {
          searchMode = "local";
        } else {
          // Embedding failures degrade to the local keyword results.
          degraded = true;
        }
      }
    }

    if (degraded) {
      searchMode = "keyword_fallback";
    }

    const fused = reciprocalRankFusion(keywordRanking, vectorRanking);

    if (fused.size === 0) {
      return { results: [], searchMode };
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

    const ranked = Array.from(bestByPage.values()).sort((left, right) => right.fused - left.fused);

    const results: PageHit[] = [];
    for (const entry of ranked) {
      if (results.length >= topK) {
        break;
      }

      const page = pages.get(entry.chunk.pageId);
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

    return { results, searchMode };
  }
}
