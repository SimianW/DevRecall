import { ulid } from "ulid";

import { normalizeUrl } from "../../lib/urlNormalize";
import type { PageCaptureInput, PageListItem, PageRecord } from "../../shared/types";
import { db, type DevRecallDatabase } from "./db";

export class PageRepo {
  constructor(private readonly database: DevRecallDatabase = db) {}

  async upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord> {
    const normalized = await normalizeUrl(input.url);
    const existing = await this.database.pages.where("urlHash").equals(normalized.urlHash).first();
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
      status: "pending",
      schemaVersion: 1,
    };

    await this.database.pages.put(page);

    return page;
  }

  async getById(id: string): Promise<PageRecord | undefined> {
    return this.database.pages.get(id);
  }

  async getByUrlHash(urlHash: string): Promise<PageRecord | undefined> {
    return this.database.pages.where("urlHash").equals(urlHash).first();
  }

  async updatePage(
    id: string,
    data: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
  ): Promise<void> {
    await this.database.pages.update(id, data);
  }

  async deleteWithChunks(id: string): Promise<void> {
    await this.database.transaction("rw", this.database.pages, this.database.chunks, async () => {
      await this.database.chunks.where("pageId").equals(id).delete();
      await this.database.pages.delete(id);
    });
  }

  async pageIdsMissingEmbeddings(): Promise<string[]> {
    const [readyPages, chunks] = await Promise.all([
      this.database.pages.where("status").equals("ready").toArray(),
      this.database.chunks.toArray(),
    ]);

    const embeddedPageIds = new Set<string>();
    for (const chunk of chunks) {
      if (chunk.embedding !== undefined) {
        embeddedPageIds.add(chunk.pageId);
      }
    }

    return readyPages.map((page) => page.id).filter((id) => !embeddedPageIds.has(id));
  }

  async getStats(): Promise<{
    pageCount: number;
    totalTextBytes: number;
    pagesMissingEmbeddings: number;
  }> {
    const pages = await this.database.pages.toArray();
    const totalTextBytes = pages.reduce((sum, p) => sum + p.fullText.length, 0);
    const pagesMissingEmbeddings = (await this.pageIdsMissingEmbeddings()).length;

    return { pageCount: pages.length, totalTextBytes, pagesMissingEmbeddings };
  }

  async listPages({ limit }: { limit: number }): Promise<PageListItem[]> {
    const pages = await this.database.pages.orderBy("savedAt").reverse().limit(limit).toArray();

    return pages.map(toPageListItem);
  }

  async exportAll(): Promise<PageRecord[]> {
    return this.database.pages.orderBy("savedAt").toArray();
  }

  async deleteAll(): Promise<void> {
    await this.database.transaction("rw", this.database.pages, this.database.chunks, async () => {
      await this.database.chunks.clear();
      await this.database.pages.clear();
    });
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
    ...(page.errorReason !== undefined ? { errorReason: page.errorReason } : {}),
  };
}
