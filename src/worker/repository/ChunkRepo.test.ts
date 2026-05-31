import { beforeEach, describe, expect, it } from "vitest";

import { ChunkRepo } from "./ChunkRepo";
import { DevRecallDatabase } from "./db";

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
    const chunks = await repo.replaceChunksForPage("page-1", [
      "first chunk",
      "second chunk",
    ]);

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
