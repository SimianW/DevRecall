import { ulid } from "ulid";

import { normalizeUrl } from "../../lib/urlNormalize";
import type { PageCaptureInput, PageListItem, PageRecord } from "../../shared/types";
import { db, type DevRecallDatabase } from "./db";

export class PageRepo {
  constructor(private readonly database: DevRecallDatabase = db) {}

  async upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord> {
    const normalized = await normalizeUrl(input.url);
    const existing = await this.database.pages
      .where("urlHash")
      .equals(normalized.urlHash)
      .first();
    const now = Date.now();

    const page: PageRecord = {
      id: existing?.id ?? ulid(),
      url: normalized.url,
      urlHash: normalized.urlHash,
      title: input.title,
      domain: normalized.domain,
      sourceType: "unknown",
      summary: "",
      topics: [],
      technologies: [],
      intent: "reference",
      fullText: input.fullText,
      savedAt: existing?.savedAt ?? now,
      visitedAt: now,
      readingTimeMs: input.readingTimeMs,
      saveMode: input.saveMode,
      status: "ready",
      schemaVersion: 1,
    };

    await this.database.pages.put(page);

    return page;
  }

  async listPages({ limit }: { limit: number }): Promise<PageListItem[]> {
    const pages = await this.database.pages
      .orderBy("savedAt")
      .reverse()
      .limit(limit)
      .toArray();

    return pages.map(toPageListItem);
  }
}

export function toPageListItem(page: PageRecord): PageListItem {
  return {
    id: page.id,
    url: page.url,
    title: page.title,
    domain: page.domain,
    sourceType: page.sourceType,
    summary: page.summary,
    topics: page.topics,
    technologies: page.technologies,
    savedAt: page.savedAt,
    status: page.status,
  };
}
