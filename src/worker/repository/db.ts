import Dexie, { type Table } from "dexie";

import type { ChunkRecord, PageRecord } from "../../shared/types";

export class DevRecallDatabase extends Dexie {
  pages!: Table<PageRecord, string>;
  chunks!: Table<ChunkRecord, string>;

  constructor(name = "devrecall") {
    super(name);

    // No legacy migration is needed before v0.1.0 because no user data has shipped.
    this.version(1).stores({
      pages:
        "&id, urlHash, savedAt, domain, platform, contentType, status, [platform+savedAt], [contentType+savedAt]",
    });

    // v2 adds chunks while keeping the current page model.
    this.version(2).stores({
      pages:
        "&id, urlHash, savedAt, domain, platform, contentType, status, [platform+savedAt], [contentType+savedAt]",
      chunks: "&id, pageId, [pageId+ordinal]",
    });
  }
}

export const db = new DevRecallDatabase();
