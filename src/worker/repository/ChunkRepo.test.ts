import { beforeEach, describe, expect, it } from "vitest";

import { ChunkRepo } from "./ChunkRepo";
import { DevRecallDatabase } from "./db";
import type { PageRecord } from "../../shared/types";

describe("ChunkRepo", () => {
  let database: DevRecallDatabase;
  let repo: ChunkRepo;

  beforeEach(async () => {
    database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    repo = new ChunkRepo(database);
    await database.delete();
    await database.open();
  });

  it("stores chunks with sequential ordinals", async () => {
    const chunks = await repo.replaceChunksForPage("page-1", ["first chunk", "second chunk"]);

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1]);
    expect(chunks.every((chunk) => chunk.pageId === "page-1")).toBe(true);

    const stored = await repo.allChunks();
    expect(stored).toHaveLength(2);
  });

  it("replaces a page's chunks instead of appending", async () => {
    await repo.replaceChunksForPage("page-1", ["old a", "old b", "old c"]);
    await repo.replaceChunksForPage("page-1", ["new a"]);

    const stored = await repo.allChunks();

    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("new a");
  });

  it("leaves other pages' chunks untouched when replacing", async () => {
    await repo.replaceChunksForPage("page-1", ["a"]);
    await repo.replaceChunksForPage("page-2", ["b"]);
    await repo.replaceChunksForPage("page-1", ["a2"]);

    const stored = await repo.allChunks();

    expect(stored).toHaveLength(2);
    expect(stored.map((chunk) => chunk.text).sort()).toEqual(["a2", "b"]);
  });

  it("deletes a page's chunks", async () => {
    await repo.replaceChunksForPage("page-1", ["a", "b"]);
    await repo.deleteForPage("page-1");

    expect(await repo.allChunks()).toHaveLength(0);
  });
});

function makePage(id: string, status: PageRecord["status"]): PageRecord {
  return {
    id,
    url: `https://example.test/${id}`,
    urlHash: id.padEnd(64, "0"),
    title: "T",
    domain: "example.test",
    sourceType: "unknown",
    summary: "",
    topics: [],
    technologies: [],
    intent: "reference",
    fullText: "full text",
    savedAt: 1,
    visitedAt: 1,
    readingTimeMs: 0,
    saveMode: "manual",
    status,
    schemaVersion: 1,
  };
}

describe("ChunkRepo.commitProcessedPage", () => {
  let database: DevRecallDatabase;
  let repo: ChunkRepo;

  beforeEach(async () => {
    database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    repo = new ChunkRepo(database);
    await database.delete();
    await database.open();
  });

  it("writes embedded chunks and flips the page in one transaction", async () => {
    await database.pages.put(makePage("page-1", "pending"));

    const records = await repo.commitProcessedPage(
      "page-1",
      [
        { text: "chunk a", embedding: Float32Array.from([1, 0]), tokenCount: 2 },
        { text: "chunk b", embedding: Float32Array.from([0, 1]), tokenCount: 3 },
      ],
      "openai:text-embedding-3-small",
      { status: "ready", summary: "done" },
    );

    expect(records.map((r) => r.ordinal)).toEqual([0, 1]);

    const stored = await repo.allChunks();
    expect(stored).toHaveLength(2);
    const first = stored.find((c) => c.ordinal === 0)!;
    expect(ArrayBuffer.isView(first.embedding)).toBe(true);
    expect(first.embedding?.constructor.name).toBe("Float32Array");
    expect(Array.from(first.embedding!)).toEqual([1, 0]);
    expect(first.embeddingModel).toBe("openai:text-embedding-3-small");
    expect(first.tokenCount).toBe(2);

    const page = await database.pages.get("page-1");
    expect(page?.status).toBe("ready");
    expect(page?.summary).toBe("done");
  });

  it("replaces pre-existing word chunks for the page", async () => {
    await database.pages.put(makePage("page-1", "pending"));
    await repo.replaceChunksForPage("page-1", ["old word chunk"]);

    await repo.commitProcessedPage(
      "page-1",
      [{ text: "new token chunk", embedding: Float32Array.from([1]), tokenCount: 4 }],
      "openai:text-embedding-3-small",
      { status: "ready" },
    );

    const stored = await repo.allChunks();
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("new token chunk");
    expect(ArrayBuffer.isView(stored[0].embedding)).toBe(true);
    expect(stored[0].embedding?.constructor.name).toBe("Float32Array");
    expect(Array.from(stored[0].embedding!)).toEqual([1]);
  });
});
