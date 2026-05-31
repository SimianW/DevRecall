import type { ContentExtractRequest, ContentExtractResponse } from "../../shared/messages";
import type { ChunkRecord, ExtractedPage, PageCaptureInput, PageRecord } from "../../shared/types";
import { chunkText } from "../../lib/chunking";
import { chunkTokens } from "../../lib/tokenChunking";
import {
  OpenAIProvider,
  type Embedder,
  type PageTagger as OpenAIPageTagger,
} from "../llm/OpenAIProvider";
import { ChunkRepo, type EmbeddedChunkInput } from "../repository/ChunkRepo";
import { PageRepo } from "../repository/PageRepo";

export type PageExtractor = {
  extract(tabId: number): Promise<ExtractedPage>;
};

export type PageWriter = {
  upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord>;
};

export type PageReader = {
  getById(id: string): Promise<PageRecord | undefined>;
  updatePage(id: string, data: Partial<Omit<PageRecord, "id" | "schemaVersion">>): Promise<void>;
};

export type ChunkWriter = {
  replaceChunksForPage(pageId: string, texts: string[]): Promise<ChunkRecord[]>;
  commitProcessedPage(
    pageId: string,
    chunks: EmbeddedChunkInput[],
    embeddingModel: string,
    pageUpdate: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
  ): Promise<ChunkRecord[]>;
};

export type PageTagger = OpenAIPageTagger;

export class ChromePageExtractor implements PageExtractor {
  async extract(tabId: number): Promise<ExtractedPage> {
    if (typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
      throw new Error("Chrome tabs messaging is unavailable");
    }

    const request: ContentExtractRequest = { type: "content.extract" };
    const response = (await chrome.tabs.sendMessage(tabId, request)) as ContentExtractResponse;

    if (response.type === "content.extractFailed") {
      throw new Error(response.payload.message);
    }

    return response.payload;
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

  async save(tabId: number): Promise<PageRecord> {
    const extracted = await this.extractor.extract(tabId);

    const page = await this.writer.upsertCapturedPage({
      ...extracted,
      saveMode: "manual",
    });

    await this.chunkWriter.replaceChunksForPage(page.id, chunkText(page.fullText));

    return page;
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

  async processPage(pageId: string, apiKey: string): Promise<PageRecord> {
    const page = await this.reader.getById(pageId);

    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }

    try {
      const result = await this.tagger.summarizeAndTag(page.fullText, page.title, page.url, apiKey);

      const tokenChunks = chunkTokens(page.fullText);
      const vectors = await this.embedder.embedBatch(
        tokenChunks.map((chunk) => chunk.text),
        apiKey,
      );
      if (vectors.length !== tokenChunks.length) {
        throw new Error(
          `Embedding count mismatch: expected ${tokenChunks.length}, got ${vectors.length}`,
        );
      }
      const embedded: EmbeddedChunkInput[] = tokenChunks.map((chunk, index) => ({
        text: chunk.text,
        embedding: vectors[index],
        tokenCount: chunk.tokenCount,
      }));

      await this.chunkWriter.commitProcessedPage(pageId, embedded, this.embedder.embeddingModel, {
        ...result,
        status: "ready",
      });

      return { ...page, ...result, status: "ready" };
    } catch (error) {
      const errorReason = error instanceof Error ? error.message : "Unknown error";

      await this.reader.updatePage(pageId, {
        status: "failed",
        errorReason,
      });

      return { ...page, status: "failed", errorReason };
    }
  }
}
