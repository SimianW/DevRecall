import { ulid } from "ulid";

import type { ChunkRecord, PageRecord } from "../../shared/types";
import { db, type DevRecallDatabase } from "./db";

export type EmbeddedChunkInput = {
  text: string;
  embedding: Float32Array;
  tokenCount: number;
};

export function makeWordChunkRecords(pageId: string, texts: string[]): ChunkRecord[] {
  return texts.map((text, ordinal) => ({
    id: ulid(),
    pageId,
    ordinal,
    text,
    schemaVersion: 1,
  }));
}

export class ChunkRepo {
  constructor(private readonly database: DevRecallDatabase = db) {}

  async replaceChunksForPage(pageId: string, texts: string[]): Promise<ChunkRecord[]> {
    const chunks = makeWordChunkRecords(pageId, texts);

    await this.database.transaction("rw", this.database.chunks, async () => {
      await this.database.chunks.where("pageId").equals(pageId).delete();

      if (chunks.length > 0) {
        await this.database.chunks.bulkPut(chunks);
      }
    });

    return chunks;
  }

  async commitProcessedPage(
    pageId: string,
    chunks: EmbeddedChunkInput[],
    embeddingModel: string,
    pageUpdate: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
    indexVersion = 1,
  ): Promise<ChunkRecord[]> {
    const records: ChunkRecord[] = chunks.map((chunk, ordinal) => ({
      id: ulid(),
      pageId,
      ordinal,
      text: chunk.text,
      embedding: chunk.embedding,
      embeddingModel,
      indexVersion,
      tokenCount: chunk.tokenCount,
      schemaVersion: 1,
    }));

    await this.database.transaction("rw", this.database.pages, this.database.chunks, async () => {
      const updated = await this.database.pages.update(pageId, pageUpdate);

      if (updated === 0) {
        throw new Error(`commitProcessedPage: page ${pageId} not found`);
      }

      await this.database.chunks.where("pageId").equals(pageId).delete();

      if (records.length > 0) {
        await this.database.chunks.bulkPut(records);
      }
    });

    return records;
  }

  async allChunks(): Promise<ChunkRecord[]> {
    return this.database.chunks.toArray();
  }

  async deleteForPage(pageId: string): Promise<void> {
    await this.database.chunks.where("pageId").equals(pageId).delete();
  }
}
