import { ulid } from "ulid";

import type { ChunkRecord } from "../../shared/types";
import { db, type DevRecallDatabase } from "./db";

export class ChunkRepo {
  constructor(private readonly database: DevRecallDatabase = db) {}

  async replaceChunksForPage(pageId: string, texts: string[]): Promise<ChunkRecord[]> {
    const chunks: ChunkRecord[] = texts.map((text, ordinal) => ({
      id: ulid(),
      pageId,
      ordinal,
      text,
      schemaVersion: 1,
    }));

    await this.database.transaction("rw", this.database.chunks, async () => {
      await this.database.chunks.where("pageId").equals(pageId).delete();

      if (chunks.length > 0) {
        await this.database.chunks.bulkPut(chunks);
      }
    });

    return chunks;
  }

  async allChunks(): Promise<ChunkRecord[]> {
    return this.database.chunks.toArray();
  }

  async deleteForPage(pageId: string): Promise<void> {
    await this.database.chunks.where("pageId").equals(pageId).delete();
  }
}
