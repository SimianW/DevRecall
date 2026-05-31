import Dexie, { type Table } from "dexie";

import type { ChunkRecord, PageRecord } from "../../shared/types";

export class DevRecallDatabase extends Dexie {
  pages!: Table<PageRecord, string>;
  chunks!: Table<ChunkRecord, string>;

  constructor(name = "devrecall") {
    super(name);

    this.version(1).stores({
      pages: "&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]",
    });

    this.version(2).stores({
      pages: "&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]",
      chunks: "&id, pageId, [pageId+ordinal]",
    });
  }
}

export const db = new DevRecallDatabase();
