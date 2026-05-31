import { bm25Search } from "../../lib/bm25";
import { highlightTerms } from "../../lib/highlight";
import type { ChunkRecord, PageHit, PageRecord } from "../../shared/types";
import { ChunkRepo } from "../repository/ChunkRepo";
import { PageRepo, toPageListItem } from "../repository/PageRepo";

export type ChunkSource = {
  allChunks(): Promise<ChunkRecord[]>;
};

export type PageSource = {
  getById(id: string): Promise<PageRecord | undefined>;
};

export type SearchOptions = {
  topK?: number;
};

const DEFAULT_TOP_K = 10;

type RankedChunk = {
  chunk: ChunkRecord;
  score: number;
  matchedTerms: string[];
};

export class RetrievalService {
  constructor(
    private readonly chunks: ChunkSource = new ChunkRepo(),
    private readonly pages: PageSource = new PageRepo(),
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<PageHit[]> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const allChunks = await this.chunks.allChunks();

    if (allChunks.length === 0) {
      return [];
    }

    const hits = bm25Search(
      trimmed,
      allChunks.map((chunk) => chunk.text),
    );

    if (hits.length === 0) {
      return [];
    }

    const bestByPage = new Map<string, RankedChunk>();
    for (const hit of hits) {
      const chunk = allChunks[hit.index];
      const current = bestByPage.get(chunk.pageId);

      if (!current || hit.score > current.score) {
        bestByPage.set(chunk.pageId, {
          chunk,
          score: hit.score,
          matchedTerms: hit.matchedTerms,
        });
      }
    }

    const ranked = Array.from(bestByPage.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);

    const results: PageHit[] = [];
    for (const entry of ranked) {
      const page = await this.pages.getById(entry.chunk.pageId);

      if (!page) {
        continue;
      }

      results.push({
        page: toPageListItem(page),
        bestChunk: {
          text: entry.chunk.text,
          ordinal: entry.chunk.ordinal,
          highlightedHtml: highlightTerms(entry.chunk.text, entry.matchedTerms),
        },
        score: entry.score,
        matchReason: "keyword",
      });
    }

    return results;
  }
}
