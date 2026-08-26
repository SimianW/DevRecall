import { ulid } from "ulid";

import { deriveExcerpt } from "../../lib/excerpt";
import { classifyPage } from "../../lib/platformClassifier";
import { normalizeUrl } from "../../lib/urlNormalize";
import type { ChunkRecord, PageCaptureInput, PageListItem, PageRecord } from "../../shared/types";
import type { PageListItemWithExcerpt } from "../../shared/messages";
import { makeWordChunkRecords } from "./ChunkRepo";
import { db, type DevRecallDatabase } from "./db";

export class PageRepo {
  constructor(private readonly database: DevRecallDatabase = db) {}

  /**
   * Saves the captured page and its keyword chunks as one local commit. The
   * transaction writes the intermediate `pending` state before the chunks, but
   * callers only receive the committed `keyword_ready` record.
   */
  async commitCapturedPage(input: PageCaptureInput, texts: string[]): Promise<PageRecord> {
    const normalized = await normalizeUrl(input.url);
    const now = Date.now();
    let attemptedPage: PageRecord | undefined;

    try {
      return await this.database.transaction(
        "rw",
        this.database.pages,
        this.database.chunks,
        async () => {
          const existing = await this.database.pages
            .where("urlHash")
            .equals(normalized.urlHash)
            .first();

          if (existing && existing.status !== "failed") {
            return existing;
          }

          const pending: PageRecord = {
            id: existing?.id ?? ulid(),
            url: normalized.url,
            urlHash: normalized.urlHash,
            title: input.title,
            domain: normalized.domain,
            ...classifyPage(normalized.url, normalized.domain),
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
          attemptedPage = pending;

          if (texts.length === 0) {
            throw new Error("No searchable text chunks produced");
          }

          await this.database.pages.put(pending);
          await this.database.chunks.where("pageId").equals(pending.id).delete();

          const chunks = makeWordChunkRecords(pending.id, texts);
          if (chunks.length > 0) {
            await this.database.chunks.bulkPut(chunks);
          }

          const keywordReady: PageRecord = { ...pending, status: "keyword_ready" };
          await this.database.pages.put(keywordReady);
          return keywordReady;
        },
      );
    } catch (error) {
      if (attemptedPage) {
        const message = error instanceof Error ? error.message : "Local save failed";
        const failed: PageRecord = {
          ...attemptedPage,
          status: "failed",
          localSaveError: message,
        };
        try {
          await this.database.pages.put(failed);
        } catch {
          // The original local write error is more useful to the caller.
        }
      }
      throw error;
    }
  }

  async retryFailedPage(id: string, texts: string[]): Promise<PageRecord> {
    return this.database.transaction("rw", this.database.pages, this.database.chunks, async () => {
      const page = await this.database.pages.get(id);
      if (!page) {
        throw new Error(`Page ${id} not found`);
      }
      if (page.status !== "failed") {
        throw new Error(`Page ${id} is not eligible for local retry (${page.status})`);
      }
      if (texts.length === 0) {
        throw new Error("No searchable text chunks produced");
      }

      const pending: PageRecord = { ...page, status: "pending" };
      delete pending.localSaveError;
      delete pending.enrichmentError;
      await this.database.pages.put(pending);
      await this.database.chunks.where("pageId").equals(id).delete();

      const chunks = makeWordChunkRecords(id, texts);
      if (chunks.length > 0) {
        await this.database.chunks.bulkPut(chunks);
      }

      const keywordReady: PageRecord = { ...pending, status: "keyword_ready" };
      await this.database.pages.put(keywordReady);
      return keywordReady;
    });
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

  async claimEnrichment(id: string): Promise<PageRecord> {
    return this.database.transaction("rw", this.database.pages, async () => {
      const page = await this.database.pages.get(id);

      if (!page) {
        throw new Error(`Page ${id} not found`);
      }
      if (page.status !== "keyword_ready") {
        throw new Error(`Page ${id} is not eligible for enrichment (${page.status})`);
      }

      const claimed: PageRecord = { ...page, status: "enriching" };
      delete claimed.enrichmentError;
      await this.database.pages.put(claimed);
      return claimed;
    });
  }

  async recoverStaleEnriching(): Promise<number> {
    return this.database.pages.where("status").equals("enriching").modify({
      status: "keyword_ready",
    });
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

  async pageIdsKeywordReady(): Promise<string[]> {
    return (await this.database.pages.where("status").equals("keyword_ready").toArray()).map(
      (page) => page.id,
    );
  }

  async pageIdsNeedingSemanticIndex(
    embeddingModel: string,
    indexVersion: number,
  ): Promise<string[]> {
    const [readyPages, chunks] = await Promise.all([
      this.database.pages.where("status").equals("ready").toArray(),
      this.database.chunks.toArray(),
    ]);
    const chunksByPage = new Map<string, ChunkRecord[]>();

    for (const chunk of chunks) {
      const pageChunks = chunksByPage.get(chunk.pageId) ?? [];
      pageChunks.push(chunk);
      chunksByPage.set(chunk.pageId, pageChunks);
    }

    return readyPages
      .filter((page) => {
        const pageChunks = chunksByPage.get(page.id) ?? [];
        return (
          pageChunks.length === 0 ||
          pageChunks.some((chunk) => {
            return (
              chunk.embedding === undefined ||
              chunk.embeddingModel !== embeddingModel ||
              chunk.indexVersion !== indexVersion
            );
          })
        );
      })
      .map((page) => page.id);
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

  async listPages({ limit }: { limit: number }): Promise<PageListItemWithExcerpt[]> {
    const pages = await this.database.pages.orderBy("savedAt").reverse().limit(limit).toArray();

    return pages.map(toPageListItemWithExcerpt);
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
    platform: page.platform,
    contentType: page.contentType,
    summary: page.summary,
    topics: page.topics,
    technologies: page.technologies,
    savedAt: page.savedAt,
    status: page.status,
    ...(page.localSaveError !== undefined ? { localSaveError: page.localSaveError } : {}),
    ...(page.enrichmentError !== undefined ? { enrichmentError: page.enrichmentError } : {}),
  };
}

/**
 * List item plus a query-time excerpt of `fullText` (the `page.listed` shape).
 * The excerpt is derived on read and never persisted — `fullText` stays the
 * only stored text of record.
 */
export function toPageListItemWithExcerpt(page: PageRecord): PageListItemWithExcerpt {
  return {
    ...toPageListItem(page),
    excerpt: deriveExcerpt(page.fullText),
  };
}
