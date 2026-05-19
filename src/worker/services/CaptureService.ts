import type {
  ContentExtractRequest,
  ContentExtractResponse,
} from "../../shared/messages";
import type { ExtractedPage, PageCaptureInput, PageRecord } from "../../shared/types";
import { PageRepo } from "../repository/PageRepo";

export type PageExtractor = {
  extract(tabId: number): Promise<ExtractedPage>;
};

export type PageWriter = {
  upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord>;
};

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
    private readonly pages: PageWriter = new PageRepo(),
    private readonly extractor: PageExtractor = new ChromePageExtractor(),
  ) {}

  async save(tabId: number): Promise<PageRecord> {
    const extracted = await this.extractor.extract(tabId);

    return this.pages.upsertCapturedPage({
      ...extracted,
      saveMode: "manual",
    });
  }
}
