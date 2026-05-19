export type SourceType =
  | "official_docs"
  | "github_issue"
  | "stackoverflow"
  | "blog"
  | "paper"
  | "course_material"
  | "unknown";

export type Intent =
  | "learning"
  | "debugging"
  | "reference"
  | "implementation"
  | "comparison";

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
