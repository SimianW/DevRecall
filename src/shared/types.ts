import type { ContentType, Platform } from "./enums";

export type Intent = "learning" | "debugging" | "reference" | "implementation" | "comparison";

export type SaveMode = "manual" | "auto";

/**
 * Page lifecycle in the keyword-first pipeline:
 *
 * - "pending"       — captured, not yet chunked / BM25-indexed
 * - "keyword_ready" — chunked and keyword-searchable; not yet enriched
 * - "enriching"     — LLM enrichment (summary/tags/embeddings) in flight
 * - "ready"         — fully enriched; hybrid-searchable
 * - "failed"        — local persistence failed before the page became searchable
 */
export type PageStatus = "pending" | "keyword_ready" | "enriching" | "ready" | "failed";

export type PageRecord = {
  id: string;
  url: string;
  urlHash: string;
  title: string;
  domain: string;
  /** Where the content lives (github, stackoverflow, mdn, ...). */
  platform: Platform;
  /** What the content is (documentation, issue, question, ...). */
  contentType: ContentType;
  summary: string;
  topics: string[];
  technologies: string[];
  intent: Intent;
  fullText: string;
  savedAt: number;
  visitedAt: number;
  readingTimeMs: number;
  saveMode: SaveMode;
  status: PageStatus;
  /** Last enrichment failure. Affected pages return to `keyword_ready`. */
  enrichmentError?: string;
  schemaVersion: 1;
};

export type PageListItem = Pick<
  PageRecord,
  | "id"
  | "url"
  | "title"
  | "domain"
  | "platform"
  | "contentType"
  | "summary"
  | "topics"
  | "technologies"
  | "savedAt"
  | "status"
  | "enrichmentError"
>;

export type ExtractedPage = {
  url: string;
  title: string;
  fullText: string;
  readingTimeMs: number;
};

export type PageCaptureInput = ExtractedPage & {
  saveMode: SaveMode;
};

export type TaggingResult = {
  summary: string;
  contentType: ContentType;
  topics: string[];
  technologies: string[];
  intent: Intent;
};

export type ChunkRecord = {
  id: string; // ULID
  pageId: string; // FK → PageRecord.id
  ordinal: number; // 0-based position within the page
  text: string; // word-window until processPage re-chunks it to token-based
  embedding?: Float32Array; // 1536 dims, L2-normalized at insert; absent until embedded
  embeddingModel?: string; // e.g. "openai:text-embedding-3-small"; absent until embedded
  indexVersion?: number; // retrieval index format version; absent until embedded
  tokenCount?: number; // tiktoken count; metadata only, not used by retrieval scoring
  schemaVersion: 1;
};

export type SearchMatchReason = "keyword" | "vector" | "both";

export type PageHit = {
  page: PageListItem;
  bestChunk: {
    text: string;
    ordinal: number;
    highlightedHtml: string; // matched terms wrapped in <mark>, HTML-escaped
  };
  scores: {
    keyword: number | null; // BM25 score, or null if the keyword arm missed this chunk
    vector: number | null; // cosine score, or null if the vector arm missed this chunk
    fused: number; // RRF fused score (the ranking key)
  };
  matchReason: SearchMatchReason;
};
