import Dexie, { type Table } from "dexie";

import type { PageRecord } from "../../shared/types";

export class DevRecallDatabase extends Dexie {
  pages!: Table<PageRecord, string>;

  constructor(name = "devrecall") {
    super(name);

    this.version(1).stores({
      pages: "&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]",
    });
  }
}

export const db = new DevRecallDatabase();
