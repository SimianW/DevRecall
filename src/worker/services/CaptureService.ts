import type {
  ContentExtractRequest,
  ContentExtractResponse,
} from "../../shared/messages";
import type {
  ChunkRecord,
  ExtractedPage,
  PageCaptureInput,
  PageRecord,
} from "../../shared/types";
import { chunkText } from "../../lib/chunking";
import {
  OpenAIProvider,
  type PageTagger as OpenAIPageTagger,
} from "../llm/OpenAIProvider";
import { ChunkRepo } from "../repository/ChunkRepo";
import { PageRepo } from "../repository/PageRepo";

export type PageExtractor = {
  extract(tabId: number): Promise<ExtractedPage>;
};

export type PageWriter = {
  upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord>;
};

export type PageReader = {
  getById(id: string): Promise<PageRecord | undefined>;
  updatePage(
    id: string,
    data: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
  ): Promise<void>;
};

export type ChunkWriter = {
  replaceChunksForPage(pageId: string, texts: string[]): Promise<ChunkRecord[]>;
};

export type PageTagger = OpenAIPageTagger;

export class ChromePageExtractor implements PageExtractor {
  async extract(tabId: number): Promise<ExtractedPage> {
    if (typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
      throw new Error("Chrome tabs messaging is unavailable");
    }

    const request: ContentExtractRequest = { type: "content.extract" };
    const response = (await chrome.tabs.sendMessage(
      tabId,
      request,
    )) as ContentExtractResponse;

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
  ) {}

  async save(tabId: number): Promise<PageRecord> {
    const extracted = await this.extractor.extract(tabId);

    const page = await this.writer.upsertCapturedPage({
      ...extracted,
      saveMode: "manual",
    });

    await this.chunkWriter.replaceChunksForPage(
      page.id,
      chunkText(page.fullText),
    );

    return page;
  }

  async processPage(pageId: string, apiKey: string): Promise<PageRecord> {
    const page = await this.reader.getById(pageId);

    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }

    try {
      const result = await this.tagger.summarizeAndTag(
        page.fullText,
        page.title,
        page.url,
        apiKey,
      );

      await this.reader.updatePage(pageId, { ...result, status: "ready" });

      return { ...page, ...result, status: "ready" };
    } catch (error) {
      const errorReason =
        error instanceof Error ? error.message : "Unknown error";

      await this.reader.updatePage(pageId, {
        status: "failed",
        errorReason,
      });

      return { ...page, status: "failed", errorReason };
    }
  }
}
