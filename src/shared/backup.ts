import { isContentType, isPlatform } from "./enums";
import type { PageRecord } from "./types";

export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
const MAX_BACKUP_PAGES = 5000;

export type BackupPage = Pick<
  PageRecord,
  | "url"
  | "title"
  | "fullText"
  | "summary"
  | "topics"
  | "technologies"
  | "platform"
  | "contentType"
  | "intent"
  | "savedAt"
  | "visitedAt"
  | "readingTimeMs"
  | "saveMode"
>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
}

/** Validate the entire backup before any database write. IDs and derived fields are ignored. */
export function parseBackup(json: string): BackupPage[] {
  if (new TextEncoder().encode(json).byteLength > MAX_BACKUP_BYTES) {
    throw new Error("Choose a backup smaller than 25 MB.");
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("This file is not valid JSON. Choose a DevRecall export.");
  }
  if (!isObject(data) || data.schemaVersion !== 1 || !Array.isArray(data.pages)) {
    throw new Error("This file is not a supported DevRecall backup.");
  }
  if (data.pages.length > MAX_BACKUP_PAGES) {
    throw new Error("A backup can contain at most 5,000 pages.");
  }

  return data.pages.map((page: unknown, index: number) => {
    const invalid = () =>
      new Error(`Page ${index + 1} in this backup is invalid. Nothing was imported.`);
    if (
      !isObject(page) ||
      typeof page.url !== "string" ||
      typeof page.title !== "string" ||
      typeof page.fullText !== "string" ||
      typeof page.summary !== "string" ||
      !isStringArray(page.topics) ||
      !isStringArray(page.technologies) ||
      !isPlatform(page.platform) ||
      !isContentType(page.contentType) ||
      !isTimestamp(page.savedAt) ||
      !isTimestamp(page.visitedAt) ||
      typeof page.readingTimeMs !== "number" ||
      !Number.isFinite(page.readingTimeMs) ||
      page.readingTimeMs < 0 ||
      (page.saveMode !== "manual" && page.saveMode !== "auto") ||
      (page.intent !== "learning" &&
        page.intent !== "debugging" &&
        page.intent !== "reference" &&
        page.intent !== "implementation" &&
        page.intent !== "comparison")
    )
      throw invalid();
    let url: URL;
    try {
      url = new URL(page.url);
    } catch {
      throw invalid();
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw invalid();
    }
    return {
      url: page.url,
      title: page.title,
      fullText: page.fullText,
      summary: page.summary,
      topics: page.topics,
      technologies: page.technologies,
      platform: page.platform,
      contentType: page.contentType,
      intent: page.intent,
      savedAt: page.savedAt,
      visitedAt: page.visitedAt,
      readingTimeMs: page.readingTimeMs,
      saveMode: page.saveMode,
    };
  });
}
