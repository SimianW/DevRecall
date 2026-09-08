import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBackup } from "../../shared/backup";
import { PageRepo } from "./PageRepo";
import { ChunkRepo } from "./ChunkRepo";
import { DevRecallDatabase } from "./db";
import { RetrievalService } from "../services/RetrievalService";

describe("library backup restore", () => {
  let database: DevRecallDatabase;
  let repo: PageRepo;
  beforeEach(async () => {
    database = new DevRecallDatabase(`backup-test-${crypto.randomUUID()}`);
    await database.open();
    repo = new PageRepo(database);
  });
  afterEach(async () => {
    await database.delete();
  });

  async function exportedPage(url = "https://example.com/guide") {
    const page = await repo.commitCapturedPage(
      {
        url,
        title: "IndexedDB guide",
        fullText: "IndexedDB stores structured data locally.",
        readingTimeMs: 3000,
        saveMode: "manual",
      },
      ["IndexedDB stores structured data locally."],
    );
    await repo.updatePage(page.id, {
      summary: "Local databases",
      topics: ["storage"],
      technologies: ["Dexie"],
      status: "ready",
    });
    return (await repo.exportAll())[0];
  }

  it("round-trips content and metadata into a locally searchable library", async () => {
    const original = await exportedPage();
    const backup = parseBackup(JSON.stringify({ schemaVersion: 1, pages: [original] }));
    await repo.deleteAll();
    expect(await repo.importPages(backup)).toEqual({ imported: 1, skipped: 0 });
    const [restored] = await repo.exportAll();
    expect(restored).toMatchObject({
      title: original.title,
      summary: original.summary,
      fullText: original.fullText,
      topics: original.topics,
      technologies: original.technologies,
      savedAt: original.savedAt,
      status: "keyword_ready",
    });
    expect(restored.id).not.toBe(original.id);
    const chunks = new ChunkRepo(database);
    expect((await chunks.allChunks()).every((chunk) => !chunk.embedding)).toBe(true);
    const search = new RetrievalService(chunks, repo);
    const result = await search.search({ query: "IndexedDB", effectiveMode: "local" });
    expect(result.results.map((hit) => hit.page.id)).toEqual([restored.id]);
  });

  it("skips existing and repeated normalized URLs without overwriting current pages", async () => {
    const original = await exportedPage();
    const backup = parseBackup(
      JSON.stringify({
        schemaVersion: 1,
        pages: [
          {
            ...original,
            title: "Overwrite attempt",
            url: `${original.url}?utm_source=backup#section`,
          },
          { ...original, url: "https://example.com/another" },
          { ...original, url: "https://example.com/another#duplicate" },
        ],
      }),
    );
    expect(await repo.importPages(backup)).toEqual({ imported: 1, skipped: 2 });
    expect(await repo.getById(original.id)).toMatchObject({
      title: "IndexedDB guide",
      status: "ready",
    });
    expect(await database.pages.count()).toBe(2);
  });

  it("rolls back all imported pages if a later chunk cannot be stored", async () => {
    const original = await exportedPage();
    const backup = parseBackup(
      JSON.stringify({
        schemaVersion: 1,
        pages: [
          { ...original, url: "https://example.com/new1" },
          { ...original, url: "https://example.com/new2", fullText: "quota-trigger" },
        ],
      }),
    );
    database.chunks.hook("creating", (_key, chunk) => {
      if (chunk.text === "quota-trigger") throw new Error("Storage full");
    });
    await expect(repo.importPages(backup)).rejects.toThrow("Storage full");
    expect(await database.pages.count()).toBe(1);
    expect(await database.chunks.count()).toBe(1);
  });

  it("rejects an import revoked before its transaction writes", async () => {
    const original = await exportedPage();
    await repo.deleteAll();
    const backup = parseBackup(JSON.stringify({ schemaVersion: 1, pages: [original] }));

    await expect(repo.importPages(backup, () => false)).rejects.toThrow("authorization");
    expect(await database.pages.count()).toBe(0);
    expect(await database.chunks.count()).toBe(0);
  });

  it("rolls back the whole import when authorization is revoked between rows", async () => {
    const original = await exportedPage();
    const backup = parseBackup(
      JSON.stringify({
        schemaVersion: 1,
        pages: [
          { ...original, url: "https://example.com/revoked-one" },
          { ...original, url: "https://example.com/revoked-two" },
        ],
      }),
    );
    let checks = 0;

    await expect(repo.importPages(backup, () => checks++ === 0)).rejects.toThrow("authorization");
    expect(await database.pages.count()).toBe(1);
    expect(await database.chunks.count()).toBe(1);
  });
});
