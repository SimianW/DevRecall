export type SourceType =
  | "official_docs"
  | "github_issue"
  | "stackoverflow"
  | "blog"
  | "paper"
  | "course_material"
  | "unknown";

export type Intent = "learning" | "debugging" | "reference" | "implementation" | "comparison";

export type SaveMode = "manual" | "auto";

export type PageStatus = "pending" | "ready" | "failed";

export type PageRecord = {
  id: string;
  url: string;
  urlHash: string;
  title: string;
  domain: string;
  sourceType: SourceType;
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
  errorReason?: string;
  schemaVersion: 1;
};

export type PageListItem = Pick<
  PageRecord,
  | "id"
  | "url"
  | "title"
  | "domain"
  | "sourceType"
  | "summary"
  | "topics"
  | "technologies"
  | "savedAt"
  | "status"
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
  sourceType: SourceType;
  topics: string[];
  technologies: string[];
  intent: Intent;
};

export type ChunkRecord = {
  id: string; // ULID
  pageId: string; // FK → PageRecord.id
  ordinal: number; // 0-based position within the page
  text: string; // simple word-window chunk; re-chunked in M5
  schemaVersion: 1;
};

export type SearchMatchReason = "keyword"; // M5 adds "vector" | "both"

export type PageHit = {
  page: PageListItem;
  bestChunk: {
    text: string;
    ordinal: number;
    highlightedHtml: string; // matched terms wrapped in <mark>, HTML-escaped
  };
  score: number;
  matchReason: SearchMatchReason;
};
