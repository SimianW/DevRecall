import type { ContentExtractRequest, ContentExtractResponse } from "../../shared/messages";
import type { ChunkRecord, ExtractedPage, PageCaptureInput, PageRecord } from "../../shared/types";
import { chunkText } from "../../lib/chunking";
import { chunkTokens } from "../../lib/tokenChunking";
import {
  OpenAIRequestAuthorizationError,
  OpenAIProvider,
  type Embedder,
  type MaySendOpenAIRequest,
  type PageTagger as OpenAIPageTagger,
} from "../llm/OpenAIProvider";
import { ChunkRepo, type EmbeddedChunkInput } from "../repository/ChunkRepo";
import { PageRepo } from "../repository/PageRepo";

export const SEMANTIC_INDEX_VERSION = 1;

export type PageExtractor = {
  extract(tabId: number): Promise<ExtractedPage>;
};

export type PageWriter = {
  commitCapturedPage(input: PageCaptureInput, texts: string[]): Promise<PageRecord>;
  retryFailedPage?(id: string, texts: string[]): Promise<PageRecord>;
};

export type PageReader = {
  getById(id: string): Promise<PageRecord | undefined>;
  claimEnrichment(id: string): Promise<PageRecord>;
  updatePage(id: string, data: Partial<Omit<PageRecord, "id" | "schemaVersion">>): Promise<void>;
  recoverStaleEnriching(): Promise<number>;
};

export type ChunkWriter = {
  replaceChunksForPage(pageId: string, texts: string[]): Promise<ChunkRecord[]>;
  commitProcessedPage(
    pageId: string,
    chunks: EmbeddedChunkInput[],
    embeddingModel: string,
    pageUpdate: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
    indexVersion?: number,
  ): Promise<ChunkRecord[]>;
};

export type PageTagger = OpenAIPageTagger;

export type FrameExtraction = {
  frameId: number;
  page: ExtractedPage;
};

/**
 * Picks the best extraction across a page's frames. Brightspace/D2L-style sites
 * render the real article inside a child iframe while the top frame holds only
 * navigation chrome, so the richest body text usually comes from a sub-frame.
 * Page identity (url + title), however, must stay anchored to the top frame —
 * the iframe's own url is not the page the user saved.
 */
export function mergeFrameExtractions(frames: FrameExtraction[]): ExtractedPage {
  if (frames.length === 0) {
    throw new Error("No readable page text found");
  }

  const richest = frames.reduce((best, current) =>
    current.page.fullText.length > best.page.fullText.length ? current : best,
  ).page;
  const top = frames.find((frame) => frame.frameId === 0)?.page;

  return {
    url: top?.url ?? richest.url,
    title: top?.title || richest.title,
    fullText: richest.fullText,
    readingTimeMs: richest.readingTimeMs,
  };
}

export class ChromePageExtractor implements PageExtractor {
  async extract(tabId: number): Promise<ExtractedPage> {
    if (typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
      throw new Error("Chrome tabs messaging is unavailable");
    }

    const request: ContentExtractRequest = { type: "content.extract" };
    const frameIds = await this.frameIds(tabId);

    const settled = await Promise.all(
      frameIds.map(async (frameId): Promise<FrameExtraction | null> => {
        try {
          const response = (await chrome.tabs.sendMessage(tabId, request, {
            frameId,
          })) as ContentExtractResponse;
          return response.type === "content.extracted" ? { frameId, page: response.payload } : null;
        } catch {
          // Frame has no content script (about:blank/srcdoc, injection blocked) — skip it.
          return null;
        }
      }),
    );

    const frames = settled.filter((entry): entry is FrameExtraction => entry !== null);

    if (frames.length === 0) {
      throw new Error("No readable page text found");
    }

    return mergeFrameExtractions(frames);
  }

  /**
   * Enumerates the tab's injectable frame ids via a no-op `scripting` injection,
   * which reuses the already-granted `scripting` permission instead of adding
   * `webNavigation` (whose "read browsing history" warning conflicts with the
   * local-first privacy posture). Falls back to the top frame when unavailable.
   */
  private async frameIds(tabId: number): Promise<number[]> {
    if (!chrome.scripting?.executeScript) {
      return [0];
    }

    try {
      const injections = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => true,
      });
      const ids = injections
        .map((injection) => injection.frameId)
        .filter((frameId): frameId is number => typeof frameId === "number");
      return ids.length > 0 ? ids : [0];
    } catch {
      return [0];
    }
  }
}

export class CaptureService {
  constructor(
    private readonly writer: PageWriter = new PageRepo(),
    private readonly extractor: PageExtractor = new ChromePageExtractor(),
    private readonly reader: PageReader = new PageRepo(),
    private readonly tagger: PageTagger = new OpenAIProvider(),
    private readonly chunkWriter: ChunkWriter = new ChunkRepo(),
    private readonly embedder: Embedder = new OpenAIProvider(),
  ) {}

  async save(tabId: number, saveMode: "manual" | "auto" = "manual"): Promise<PageRecord> {
    const extracted = await this.extractor.extract(tabId);
    return this.writer.commitCapturedPage(
      { ...extracted, saveMode },
      chunkText(extracted.fullText),
    );
  }

  async recoverStaleEnriching(): Promise<number> {
    return this.reader.recoverStaleEnriching();
  }

  async retryLocalPage(pageId: string): Promise<PageRecord> {
    const page = await this.reader.getById(pageId);
    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }
    if (page.status !== "failed") {
      throw new Error(`Page ${pageId} is not eligible for local retry (${page.status})`);
    }
    if (!this.writer.retryFailedPage) {
      throw new Error("Local retry is unavailable");
    }

    return this.writer.retryFailedPage(pageId, chunkText(page.fullText));
  }

  async reindexPages(
    pageIds: string[],
    apiKey: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<void> {
    let done = 0;
    for (const id of pageIds) {
      await this.processPage(id, apiKey);
      done += 1;
      onProgress(done, pageIds.length);
    }
  }

  /**
   * Rebuilds embeddings for a page without re-running enrichment.
   *
   * The optional `mayProceed` callback is called BEFORE the embedding request
   * to provide send-time authorization, ensuring Local-only changes are respected.
   */
  async reindexSemanticPage(
    pageId: string,
    apiKey: string,
    mayProceed?: MaySendOpenAIRequest,
  ): Promise<PageRecord> {
    const page = await this.reader.getById(pageId);

    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }
    if (page.status !== "ready") {
      throw new Error(`Page ${pageId} is not ready for semantic re-indexing`);
    }

    // Send-time authorization check before embedding request
    if (mayProceed && !(await mayProceed())) {
      throw new OpenAIRequestAuthorizationError();
    }

    const embedded = await this.embedChunks(page.fullText, apiKey, mayProceed);
    await this.chunkWriter.commitProcessedPage(
      pageId,
      embedded,
      this.embedder.embeddingModel,
      { status: "ready" },
      SEMANTIC_INDEX_VERSION,
    );

    return page;
  }

  /**
   * Processes a page through the full enrichment pipeline.
   *
   * The optional `mayProceed` callback is called AFTER claimEnrichment but BEFORE
   * any OpenAI requests. This allows checking the effective mode at send-time,
   * closing the privacy race where Local-only could be enabled after the claim
   * but before the network request.
   *
   * If `mayProceed` returns false, the page is restored to `keyword_ready` and no
   * OpenAI requests are made.
   */
  async processPage(
    pageId: string,
    apiKey: string,
    mayProceed?: MaySendOpenAIRequest,
  ): Promise<PageRecord> {
    const page = await this.reader.claimEnrichment(pageId);

    // Send-time authorization check: after claim, before OpenAI requests
    if (mayProceed && !(await mayProceed())) {
      return this.restoreKeywordReady(page);
    }

    try {
      const result = mayProceed
        ? await this.tagger.summarizeAndTag(
            page.fullText,
            page.title,
            page.url,
            apiKey,
            page.contentType,
            mayProceed,
          )
        : await this.tagger.summarizeAndTag(
            page.fullText,
            page.title,
            page.url,
            apiKey,
            page.contentType,
          );

      if (mayProceed && !(await mayProceed())) {
        return this.restoreKeywordReady(page);
      }

      const embedded = await this.embedChunks(page.fullText, apiKey, mayProceed);

      await this.chunkWriter.commitProcessedPage(
        pageId,
        embedded,
        this.embedder.embeddingModel,
        {
          ...result,
          status: "ready",
          enrichmentError: undefined,
        },
        SEMANTIC_INDEX_VERSION,
      );

      return { ...page, ...result, status: "ready", enrichmentError: undefined };
    } catch (error) {
      if (error instanceof OpenAIRequestAuthorizationError) {
        return this.restoreKeywordReady(page);
      }

      const enrichmentError = error instanceof Error ? error.message : "Unknown error";

      await this.reader.updatePage(pageId, {
        status: "keyword_ready",
        enrichmentError,
      });

      return { ...page, status: "keyword_ready", enrichmentError };
    }
  }

  private async restoreKeywordReady(page: PageRecord): Promise<PageRecord> {
    await this.reader.updatePage(page.id, {
      status: "keyword_ready",
      enrichmentError: undefined,
    });
    return { ...page, status: "keyword_ready", enrichmentError: undefined };
  }

  private async embedChunks(
    fullText: string,
    apiKey: string,
    mayProceed?: MaySendOpenAIRequest,
  ): Promise<EmbeddedChunkInput[]> {
    const tokenChunks = chunkTokens(fullText);
    const texts = tokenChunks.map((chunk) => chunk.text);
    const vectors = mayProceed
      ? await this.embedder.embedBatch(texts, apiKey, mayProceed)
      : await this.embedder.embedBatch(texts, apiKey);
    if (vectors.length !== tokenChunks.length) {
      throw new Error(
        `Embedding count mismatch: expected ${tokenChunks.length}, got ${vectors.length}`,
      );
    }

    return tokenChunks.map((chunk, index) => ({
      text: chunk.text,
      embedding: vectors[index],
      tokenCount: chunk.tokenCount,
    }));
  }
}
