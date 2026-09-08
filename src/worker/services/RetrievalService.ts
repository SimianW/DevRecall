import { Bm25Index, tokenize } from "../../lib/bm25";
import { highlightTerms } from "../../lib/highlight";
import { matchReasonFor, reciprocalRankFusion } from "../../lib/rrf";
import { cosineTopK } from "../../lib/vector";
import type { EffectiveMode, SearchMode } from "../../shared/modes";
import type { ChunkRecord, PageHit, PageRecord, SearchFilter } from "../../shared/types";
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
  filter?: SearchFilter;
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
const ARM_TOP_K = 50;
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

type KeywordDocument = {
  pageId: string;
  text: string;
  chunk: ChunkRecord | null;
  boost: number;
};

type KeywordPageCandidate = {
  score: number;
  contentChunk: ChunkRecord | null;
  contentTerms: string[];
  metadataTerms: string[];
};

type VectorPageCandidate = {
  score: number;
  contentChunk: ChunkRecord;
};

type SearchCorpus = {
  chunks: ChunkRecord[];
  pages: Map<string, PageRecord>;
  keywordDocuments: KeywordDocument[];
  keywordIndex: Bm25Index;
};

const METADATA_FIELDS: ReadonlyArray<{
  field: "title" | "summary" | "topics" | "technologies" | "domain" | "url";
  boost: number;
  value: (page: PageRecord) => string;
}> = [
  { field: "title", boost: 4, value: (page) => page.title },
  { field: "topics", boost: 2.5, value: (page) => page.topics.join(" ") },
  { field: "technologies", boost: 2.5, value: (page) => page.technologies.join(" ") },
  { field: "domain", boost: 2, value: (page) => page.domain },
  { field: "url", boost: 1.5, value: (page) => page.url },
  { field: "summary", boost: 1, value: (page) => page.summary },
];

function highlightFieldMatch(text: string, matchedTerms: readonly string[]): string | null {
  const fieldTerms = new Set(tokenize(text));
  if (!matchedTerms.some((term) => fieldTerms.has(term))) {
    return null;
  }

  return highlightTerms(text, [...matchedTerms]);
}

function matchesFilter(page: PageRecord, filter: SearchFilter | undefined): boolean {
  return (
    (filter?.platform === undefined || page.platform === filter.platform) &&
    (filter?.contentType === undefined || page.contentType === filter.contentType)
  );
}

const SEARCHABLE_STATUSES = new Set<PageRecord["status"]>(["keyword_ready", "enriching", "ready"]);

export class RetrievalService {
  private corpusCache: SearchCorpus | null = null;
  private readonly queryCache = new Map<string, SearchOutcome>();
  private readonly inFlightQueries = new Map<
    string,
    { version: number; promise: Promise<SearchOutcome> }
  >();
  private corpusVersion = 0;
  private corpusLoad: { version: number; promise: Promise<SearchCorpus> } | null = null;

  constructor(
    private readonly chunks: ChunkSource = new ChunkRepo(),
    private readonly pages: PageSource = new PageRepo(),
    private readonly embedder: Embedder = new OpenAIProvider(),
    private readonly apiKeyStore: Pick<ApiKeyStore, "getApiKey"> = new ChromeApiKeyStore(),
  ) {}

  /** Clears the in-memory corpus and query cache. Called on any page change. */
  invalidate(): void {
    this.corpusVersion += 1;
    this.corpusCache = null;
    this.corpusLoad = null;
    this.queryCache.clear();
    this.inFlightQueries.clear();
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

    // Recheck permission before even returning a cached Hybrid result. Settings
    // can change while the handler is resolving this request's initial mode.
    const effectiveMode =
      input.effectiveMode === "hybrid" && input.resolveEffectiveMode
        ? await input.resolveEffectiveMode()
        : input.effectiveMode;
    const filterKey = `${input.filter?.platform ?? ""}|${input.filter?.contentType ?? ""}`;
    const cacheKey = `${effectiveMode}|${topK}|${filterKey}|${trimmed}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      // LRU touch: re-insert to mark most-recently-used.
      this.queryCache.delete(cacheKey);
      this.queryCache.set(cacheKey, cached);
      return cached;
    }

    const version = this.corpusVersion;
    // A caller-provided mode resolver is an authorization check, not merely
    // a hint. Do not let one request's in-flight result bypass another request's
    // privacy revision or key check. Local searches have no external side
    // effect and can safely share their in-flight computation.
    const canDeduplicate = input.resolveEffectiveMode === undefined;
    const existing = canDeduplicate ? this.inFlightQueries.get(cacheKey) : undefined;
    if (existing?.version === version) return existing.promise;

    const promise = this.computeSearch(
      trimmed,
      topK,
      input.filter,
      effectiveMode,
      input.resolveEffectiveMode,
    );
    if (canDeduplicate) this.inFlightQueries.set(cacheKey, { version, promise });
    let outcome: SearchOutcome;
    try {
      outcome = await promise;
    } finally {
      if (canDeduplicate && this.inFlightQueries.get(cacheKey)?.promise === promise) {
        this.inFlightQueries.delete(cacheKey);
      }
    }

    // Cache only the mode this request was authorized to run. A fallback or a
    // Hybrid request revoked to Local-only must be recomputed after recovery.
    if (version === this.corpusVersion && outcome.searchMode === effectiveMode) {
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
    while (true) {
      if (this.corpusCache !== null) return this.corpusCache;

      const version = this.corpusVersion;
      let promise = this.corpusLoad?.version === version ? this.corpusLoad.promise : undefined;
      if (!promise) {
        promise = this.readCorpus();
        this.corpusLoad = { version, promise };
        void promise.then(
          (corpus) => {
            if (this.corpusVersion === version) this.corpusCache = corpus;
          },
          () => {
            if (this.corpusLoad?.promise === promise) this.corpusLoad = null;
          },
        );
      }

      const corpus = await promise;
      if (version === this.corpusVersion) return corpus;
      // invalidate() happened while the source was being read. Join the new
      // generation rather than returning an obsolete corpus to the caller.
    }
  }

  private async readCorpus(): Promise<SearchCorpus> {
    const chunks = await this.chunks.allChunks();
    const pageIds = Array.from(new Set(chunks.map((chunk) => chunk.pageId)));
    const records = await Promise.all(pageIds.map((pageId) => this.pages.getById(pageId)));
    const pages = new Map<string, PageRecord>();

    for (const page of records) {
      if (page && SEARCHABLE_STATUSES.has(page.status)) pages.set(page.id, page);
    }

    const searchableChunks = chunks.filter((chunk) => pages.has(chunk.pageId));
    const keywordDocuments: KeywordDocument[] = [
      ...searchableChunks.map((chunk) => ({
        pageId: chunk.pageId,
        text: chunk.text,
        chunk,
        boost: 1,
      })),
      ...Array.from(pages.values()).flatMap((page) =>
        METADATA_FIELDS.map(({ boost, value }) => ({
          pageId: page.id,
          text: value(page),
          chunk: null,
          boost,
        })),
      ),
    ];

    return {
      chunks: searchableChunks,
      pages,
      keywordDocuments,
      keywordIndex: new Bm25Index(keywordDocuments.map((document) => document.text)),
    };
  }

  private async computeSearch(
    trimmed: string,
    topK: number,
    filter: SearchFilter | undefined,
    effectiveMode: EffectiveMode,
    resolveEffectiveMode?: () => Promise<EffectiveMode>,
  ): Promise<SearchOutcome> {
    const { chunks: allChunks, pages, keywordDocuments, keywordIndex } = await this.loadCorpus();

    if (allChunks.length === 0) {
      return { results: [], searchMode: effectiveMode };
    }

    // Keyword arm: the corpus index contains every content chunk and each
    // searchable metadata field. Collapse document hits to pages so repeated
    // chunks cannot crowd other pages out of the arm's candidate window.
    const keywordCandidates = new Map<string, KeywordPageCandidate>();
    const rankedKeywordPages: string[] = [];
    for (const hit of keywordIndex.search(trimmed, { topK: keywordDocuments.length })) {
      const document = keywordDocuments[hit.index];
      const page = pages.get(document.pageId);
      // Apply filters before collapsing and limiting the keyword arm. The
      // index stays reusable across filters, while excluded pages cost no
      // candidate slot.
      if (!page || !matchesFilter(page, filter)) continue;
      let candidate = keywordCandidates.get(document.pageId);
      if (!candidate) {
        candidate = {
          score: hit.score * document.boost,
          contentChunk: null,
          contentTerms: [],
          metadataTerms: [],
        };
        keywordCandidates.set(document.pageId, candidate);
        rankedKeywordPages.push(document.pageId);
      } else if (hit.score * document.boost > candidate.score) {
        candidate.score = hit.score * document.boost;
      }
      if (document.chunk && !candidate.contentChunk) {
        candidate.contentChunk = document.chunk;
        candidate.contentTerms = hit.matchedTerms;
      } else if (!document.chunk) {
        candidate.metadataTerms = Array.from(
          new Set([...candidate.metadataTerms, ...hit.matchedTerms]),
        );
      }
    }
    const keywordOrder = new Map(rankedKeywordPages.map((pageId, index) => [pageId, index]));
    const keywordRanking = [...rankedKeywordPages]
      .sort((left, right) => {
        const scoreDelta =
          (keywordCandidates.get(right)?.score ?? 0) - (keywordCandidates.get(left)?.score ?? 0);
        return scoreDelta || (keywordOrder.get(left) ?? 0) - (keywordOrder.get(right) ?? 0);
      })
      .slice(0, ARM_TOP_K);

    // Vector arm — hybrid mode only. Any failure (missing key, embed error)
    // degrades the whole query to keyword_fallback rather than throwing.
    const vectorCandidates = new Map<string, VectorPageCandidate>();
    const rankedVectorPages: string[] = [];
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
            for (const hit of cosineTopK(queryVector, allChunks, allChunks.length)) {
              const chunk = allChunks[hit.index];
              const page = pages.get(chunk.pageId);
              if (!page || !matchesFilter(page, filter)) continue;
              if (hit.score < MIN_VECTOR_SCORE) break; // results are sorted desc, can break early
              if (!vectorCandidates.has(chunk.pageId)) {
                rankedVectorPages.push(chunk.pageId);
                vectorCandidates.set(chunk.pageId, { score: hit.score, contentChunk: chunk });
              }
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

    const vectorRanking = rankedVectorPages.slice(0, ARM_TOP_K);
    const fused = reciprocalRankFusion(keywordRanking, vectorRanking);

    if (fused.size === 0) {
      return { results: [], searchMode };
    }

    const firstChunkByPage = new Map<string, ChunkRecord>();
    for (const chunk of allChunks) {
      const current = firstChunkByPage.get(chunk.pageId);
      if (!current || chunk.ordinal < current.ordinal) {
        firstChunkByPage.set(chunk.pageId, chunk);
      }
    }

    const ranked = Array.from(fused.entries()).sort(
      ([, left], [, right]) => right.fused - left.fused,
    );

    const results: PageHit[] = [];
    for (const [pageId, entry] of ranked) {
      if (results.length >= topK) {
        break;
      }

      const page = pages.get(pageId);
      const keywordCandidate = entry.inKeyword ? keywordCandidates.get(pageId) : undefined;
      const vectorCandidate = entry.inVector ? vectorCandidates.get(pageId) : undefined;
      const bestChunk =
        keywordCandidate?.contentChunk ??
        vectorCandidate?.contentChunk ??
        firstChunkByPage.get(pageId);
      if (!page || !bestChunk) {
        continue;
      }

      const matchedTerms = keywordCandidate?.contentTerms ?? [];
      const matchedMetadataTerms = keywordCandidate?.metadataTerms ?? [];

      results.push({
        page: toPageListItem(page),
        bestChunk: {
          text: bestChunk.text,
          ordinal: bestChunk.ordinal,
          highlightedHtml: highlightTerms(bestChunk.text, matchedTerms),
        },
        metadataMatches: {
          titleHighlightedHtml: highlightFieldMatch(page.title, matchedMetadataTerms),
          summaryHighlightedHtml: highlightFieldMatch(page.summary, matchedMetadataTerms),
          fields: METADATA_FIELDS.flatMap(({ field, value }) => {
            if (field === "title" || field === "summary") return [];
            const highlightedHtml = highlightFieldMatch(value(page), matchedMetadataTerms);
            return highlightedHtml ? [{ field, highlightedHtml }] : [];
          }),
        },
        scores: {
          keyword: keywordCandidate?.score ?? null,
          vector: vectorCandidate?.score ?? null,
          fused: entry.fused,
        },
        matchReason: matchReasonFor(entry),
      });
    }

    return { results, searchMode };
  }
}
