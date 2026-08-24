import { beforeEach, describe, expect, it } from "vitest";

import { DevRecallDatabase } from "./db";
import { ChunkRepo } from "./ChunkRepo";
import { PageRepo } from "./PageRepo";

import { deriveExcerpt } from "../../lib/excerpt";
import { ContentType, Platform } from "../../shared/enums";

describe("PageRepo", () => {
  let database: DevRecallDatabase;
  let repo: PageRepo;

  beforeEach(async () => {
    database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    repo = new PageRepo(database);
    await database.delete();
    await database.open();
  });

  it("stores a manually captured page with M2 defaults", async () => {
    const page = await repo.upsertCapturedPage({
      url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/?utm_source=demo#walkthrough",
      title: "Horizontal Pod Autoscaling",
      fullText: "The HorizontalPodAutoscaler automatically updates workload resources.",
      readingTimeMs: 42_000,
      saveMode: "manual",
    });

    expect(page).toMatchObject({
      url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      title: "Horizontal Pod Autoscaling",
      domain: "kubernetes.io",
      platform: Platform.Web,
      contentType: ContentType.Documentation,
      summary: "",
      topics: [],
      technologies: [],
      intent: "reference",
      fullText: "The HorizontalPodAutoscaler automatically updates workload resources.",
      readingTimeMs: 42_000,
      saveMode: "manual",
      status: "pending",
      schemaVersion: 1,
    });
    expect(page.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(page.urlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.savedAt).toBeGreaterThan(0);
    expect(page.visitedAt).toBeGreaterThanOrEqual(page.savedAt);
  });

  it("updates an existing URL in place instead of creating duplicates", async () => {
    const first = await repo.upsertCapturedPage({
      url: "https://react.dev/reference/react/useMemo?utm_campaign=first",
      title: "useMemo old title",
      fullText: "Old content",
      readingTimeMs: 1000,
      saveMode: "manual",
    });

    const second = await repo.upsertCapturedPage({
      url: "https://react.dev/reference/react/useMemo",
      title: "useMemo",
      fullText: "New content",
      readingTimeMs: 2000,
      saveMode: "manual",
    });

    const pages = await repo.listPages({ limit: 10 });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("useMemo");
    expect(second.fullText).toBe("New content");
    expect(second.savedAt).toBe(first.savedAt);
    expect(second.visitedAt).toBeGreaterThanOrEqual(first.visitedAt);
    expect(pages).toHaveLength(1);
  });

  it("commits a captured page and its keyword chunks before returning keyword_ready", async () => {
    const page = await repo.commitCapturedPage(
      {
        url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
        title: "Fetch API",
        fullText: "Fetch returns a response with a readable stream.",
        readingTimeMs: 1000,
        saveMode: "manual",
      },
      ["Fetch returns a response", "readable stream"],
    );

    expect(page).toMatchObject({
      status: "keyword_ready",
      platform: Platform.Mdn,
      contentType: ContentType.Documentation,
    });
    await expect(repo.getById(page.id)).resolves.toMatchObject({ status: "keyword_ready" });

    const chunks = (await new ChunkRepo(database).allChunks()).sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Fetch returns a response",
      "readable stream",
    ]);
    expect(chunks.every((chunk) => chunk.embedding === undefined)).toBe(true);
  });

  it("rolls back the local transaction and records failed when a chunk write fails", async () => {
    database.chunks.hook("creating", () => {
      throw new Error("IndexedDB quota exceeded");
    });

    await expect(
      repo.commitCapturedPage(
        {
          url: "https://example.test/quota-failure",
          title: "Quota failure",
          fullText: "This chunk cannot be stored.",
          readingTimeMs: 1000,
          saveMode: "manual",
        },
        ["This chunk cannot be stored."],
      ),
    ).rejects.toThrow(/quota/i);

    expect(await database.chunks.count()).toBe(0);
    const [failed] = await database.pages.toArray();
    expect(failed).toMatchObject({
      status: "failed",
      enrichmentError: "IndexedDB quota exceeded",
    });
  });

  it("never marks a page keyword_ready when chunking produced no searchable chunks", async () => {
    await expect(
      repo.commitCapturedPage(
        {
          url: "https://example.test/empty",
          title: "Empty page",
          fullText: "",
          readingTimeMs: 0,
          saveMode: "manual",
        },
        [],
      ),
    ).rejects.toThrow("No searchable text chunks produced");

    expect(await database.chunks.count()).toBe(0);
    await expect(database.pages.toArray()).resolves.toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("deduplicates live statuses and retries a failed capture in place", async () => {
    const input = {
      url: "https://example.test/dedup",
      title: "Original",
      fullText: "original body",
      readingTimeMs: 1000,
      saveMode: "manual" as const,
    };
    const original = await repo.commitCapturedPage(input, ["original body"]);

    for (const status of ["pending", "keyword_ready", "enriching", "ready"] as const) {
      await repo.updatePage(original.id, { status });
      const duplicate = await repo.commitCapturedPage(
        { ...input, title: "Duplicate", fullText: "duplicate body" },
        ["duplicate body"],
      );

      expect(duplicate).toMatchObject({ id: original.id, title: "Original", status });
      expect((await new ChunkRepo(database).allChunks()).map((chunk) => chunk.text)).toEqual([
        "original body",
      ]);
    }

    await repo.updatePage(original.id, {
      status: "failed",
      enrichmentError: "previous failure",
    });
    const retried = await repo.commitCapturedPage(
      { ...input, title: "Retried", fullText: "fresh body" },
      ["fresh body"],
    );

    expect(retried).toMatchObject({
      id: original.id,
      title: "Retried",
      status: "keyword_ready",
    });
    expect(retried.enrichmentError).toBeUndefined();
    expect((await new ChunkRepo(database).allChunks()).map((chunk) => chunk.text)).toEqual([
      "fresh body",
    ]);
    expect(await database.pages.count()).toBe(1);
  });

  it("rebuilds a failed page and its keyword chunks in one local retry", async () => {
    const original = await repo.commitCapturedPage(
      {
        url: "https://example.test/local-retry",
        title: "Local retry",
        fullText: "stored full text survives the failed write",
        readingTimeMs: 1000,
        saveMode: "manual",
      },
      ["old chunk"],
    );
    await repo.updatePage(original.id, {
      status: "failed",
      enrichmentError: "local write failed",
    });

    const retried = await repo.retryFailedPage(original.id, ["rebuilt one", "rebuilt two"]);

    expect(retried).toMatchObject({ id: original.id, status: "keyword_ready" });
    expect(retried.enrichmentError).toBeUndefined();
    const chunks = (await new ChunkRepo(database).allChunks()).sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    expect(chunks.map((chunk) => chunk.text)).toEqual(["rebuilt one", "rebuilt two"]);
  });

  it("recovers only stale enriching pages without touching chunks", async () => {
    const stale = await repo.commitCapturedPage(
      {
        url: "https://example.test/stale",
        title: "Stale",
        fullText: "stale keyword body",
        readingTimeMs: 1000,
        saveMode: "manual",
      },
      ["stale keyword body"],
    );
    const ready = await repo.commitCapturedPage(
      {
        url: "https://example.test/ready",
        title: "Ready",
        fullText: "ready keyword body",
        readingTimeMs: 1000,
        saveMode: "manual",
      },
      ["ready keyword body"],
    );
    await repo.updatePage(stale.id, { status: "enriching" });
    await repo.updatePage(ready.id, { status: "ready" });
    const chunksBefore = await new ChunkRepo(database).allChunks();

    await expect(repo.recoverStaleEnriching()).resolves.toBe(1);

    expect((await repo.getById(stale.id))?.status).toBe("keyword_ready");
    expect((await repo.getById(ready.id))?.status).toBe("ready");
    expect(await new ChunkRepo(database).allChunks()).toHaveLength(chunksBefore.length);
  });

  it("atomically claims a keyword-ready page for enrichment and clears its old error", async () => {
    const page = await repo.commitCapturedPage(
      {
        url: "https://example.test/claim",
        title: "Claim",
        fullText: "claim body",
        readingTimeMs: 0,
        saveMode: "manual",
      },
      ["claim body"],
    );
    await repo.updatePage(page.id, { enrichmentError: "old error" });

    const claimed = await repo.claimEnrichment(page.id);

    expect(claimed.status).toBe("enriching");
    expect(claimed.enrichmentError).toBeUndefined();
    await expect(repo.getById(page.id)).resolves.toMatchObject({ status: "enriching" });
  });

  it("allows only one concurrent enrichment claim", async () => {
    const page = await repo.commitCapturedPage(
      {
        url: "https://example.test/concurrent-claim",
        title: "Concurrent claim",
        fullText: "claim body",
        readingTimeMs: 0,
        saveMode: "manual",
      },
      ["claim body"],
    );

    const attempts = await Promise.allSettled([
      repo.claimEnrichment(page.id),
      repo.claimEnrichment(page.id),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await repo.getById(page.id))?.status).toBe("enriching");
  });

  it("lists pages newest first without fullText", async () => {
    const older = await repo.upsertCapturedPage({
      url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API",
      title: "IndexedDB API",
      fullText: "IndexedDB stores structured data.",
      readingTimeMs: 3000,
      saveMode: "manual",
    });
    await repo.updatePage(older.id, { savedAt: 1 });

    const newer = await repo.upsertCapturedPage({
      url: "https://stackoverflow.com/questions/1/example",
      title: "Example Stack Overflow answer",
      fullText: "A useful debugging note.",
      readingTimeMs: 4000,
      saveMode: "manual",
    });
    await repo.updatePage(newer.id, { savedAt: 2 });

    const pages = await repo.listPages({ limit: 10 });

    expect(pages.map((page) => page.title)).toEqual([
      "Example Stack Overflow answer",
      "IndexedDB API",
    ]);
    expect(pages[0]).not.toHaveProperty("fullText");
  });

  it("retrieves a page by id", async () => {
    const page = await repo.upsertCapturedPage({
      url: "https://react.dev/reference/react/useState",
      title: "useState",
      fullText: "Returns a stateful value.",
      readingTimeMs: 5000,
      saveMode: "manual",
    });

    const found = await repo.getById(page.id);

    expect(found).toMatchObject({ id: page.id, title: "useState" });
  });

  it("returns undefined for a missing id", async () => {
    const found = await repo.getById("01NONEXISTENT0000000000000");

    expect(found).toBeUndefined();
  });

  it("updates a page with partial data", async () => {
    const page = await repo.upsertCapturedPage({
      url: "https://react.dev/reference/react/useEffect",
      title: "useEffect",
      fullText: "Lets you synchronize a component.",
      readingTimeMs: 6000,
      saveMode: "manual",
    });

    await repo.updatePage(page.id, {
      summary: "Synchronizes a component with an external system.",
      contentType: ContentType.Documentation,
      topics: ["react", "hooks"],
      technologies: ["React"],
      intent: "reference",
      status: "ready",
    });

    const updated = await repo.getById(page.id);

    expect(updated).toMatchObject({
      id: page.id,
      title: "useEffect",
      summary: "Synchronizes a component with an external system.",
      contentType: ContentType.Documentation,
      topics: ["react", "hooks"],
      technologies: ["React"],
      intent: "reference",
      status: "ready",
    });
  });

  it("looks up a page by url hash", async () => {
    const page = await repo.upsertCapturedPage({
      url: "https://github.com/alvinunreal/oh-my-opencode-slim",
      title: "oh-my-opencode-slim",
      fullText: "A slim variant.",
      readingTimeMs: 4000,
      saveMode: "manual",
    });

    const found = await repo.getByUrlHash(page.urlHash);

    expect(found).toMatchObject({ id: page.id, title: "oh-my-opencode-slim" });
  });

  it("returns undefined for an unknown url hash", async () => {
    await expect(repo.getByUrlHash("z".repeat(64))).resolves.toBeUndefined();
  });

  it("deletes a page and its chunks in one transaction", async () => {
    const chunkRepo = new ChunkRepo(database);

    const saved = await repo.upsertCapturedPage({
      url: "https://example.test/delete-me",
      title: "Delete me",
      fullText: "body",
      readingTimeMs: 0,
      saveMode: "manual",
    });
    await chunkRepo.replaceChunksForPage(saved.id, ["chunk one", "chunk two"]);

    await repo.deleteWithChunks(saved.id);

    expect(await repo.getById(saved.id)).toBeUndefined();
    expect(await chunkRepo.allChunks()).toHaveLength(0);
  });

  it("deleteAll clears all pages and chunks atomically", async () => {
    const chunkRepo = new ChunkRepo(database);

    const p1 = await repo.upsertCapturedPage({
      url: "https://example.test/page-one",
      title: "Page One",
      fullText: "body one",
      readingTimeMs: 0,
      saveMode: "manual",
    });
    const p2 = await repo.upsertCapturedPage({
      url: "https://example.test/page-two",
      title: "Page Two",
      fullText: "body two",
      readingTimeMs: 0,
      saveMode: "manual",
    });
    await chunkRepo.replaceChunksForPage(p1.id, ["chunk a", "chunk b"]);
    await chunkRepo.replaceChunksForPage(p2.id, ["chunk c"]);

    expect(await database.pages.count()).toBe(2);
    expect(await database.chunks.count()).toBe(3);

    await repo.deleteAll();

    expect(await database.pages.count()).toBe(0);
    expect(await database.chunks.count()).toBe(0);
  });

  it("exportAll returns all pages ordered by savedAt ascending", async () => {
    // Insert pages with explicit savedAt ordering by controlling time
    const p1 = await repo.upsertCapturedPage({
      url: "https://example.test/alpha",
      title: "Alpha",
      fullText: "first",
      readingTimeMs: 0,
      saveMode: "manual",
    });
    // Force distinct savedAt values by updating manually
    await repo.updatePage(p1.id, { savedAt: 1000 });

    const p2 = await repo.upsertCapturedPage({
      url: "https://example.test/beta",
      title: "Beta",
      fullText: "second",
      readingTimeMs: 0,
      saveMode: "manual",
    });
    await repo.updatePage(p2.id, { savedAt: 3000 });

    const p3 = await repo.upsertCapturedPage({
      url: "https://example.test/gamma",
      title: "Gamma",
      fullText: "third",
      readingTimeMs: 0,
      saveMode: "manual",
    });
    await repo.updatePage(p3.id, { savedAt: 2000 });

    const exported = await repo.exportAll();

    expect(exported).toHaveLength(3);
    // exportAll uses orderBy("savedAt") — ascending order
    expect(exported.map((p) => p.title)).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("lists ready pages missing embeddings and counts them in stats", async () => {
    const chunkRepo = new ChunkRepo(database);

    const m4 = await repo.upsertCapturedPage({
      url: "https://example.test/m4",
      title: "M4 page",
      fullText: "body",
      readingTimeMs: 0,
      saveMode: "manual",
    });
    await repo.updatePage(m4.id, { status: "ready" });
    await chunkRepo.replaceChunksForPage(m4.id, ["word chunk, no vector"]);

    const m5 = await repo.upsertCapturedPage({
      url: "https://example.test/m5",
      title: "M5 page",
      fullText: "body",
      readingTimeMs: 0,
      saveMode: "manual",
    });
    await chunkRepo.commitProcessedPage(
      m5.id,
      [{ text: "token chunk", embedding: Float32Array.from([1, 0]), tokenCount: 2 }],
      "openai:text-embedding-3-small",
      { status: "ready" },
    );

    expect(await repo.pageIdsMissingEmbeddings()).toEqual([m4.id]);

    const stats = await repo.getStats();
    expect(stats.pagesMissingEmbeddings).toBe(1);
    expect(stats.pageCount).toBe(2);
  });

  it("lists only keyword-ready pages for enrichment", async () => {
    const keywordReady = await repo.commitCapturedPage(
      {
        url: "https://example.test/keyword-ready",
        title: "Keyword ready",
        fullText: "keyword body",
        readingTimeMs: 0,
        saveMode: "manual",
      },
      ["keyword body"],
    );
    const ready = await repo.commitCapturedPage(
      {
        url: "https://example.test/already-ready",
        title: "Already ready",
        fullText: "ready body",
        readingTimeMs: 0,
        saveMode: "manual",
      },
      ["ready body"],
    );
    await repo.updatePage(ready.id, { status: "ready" });

    expect(await repo.pageIdsKeywordReady()).toEqual([keywordReady.id]);
  });

  it("finds ready pages with missing or stale semantic chunks", async () => {
    const chunkRepo = new ChunkRepo(database);
    const makeReadyPage = async (slug: string) => {
      const page = await repo.commitCapturedPage(
        {
          url: `https://example.test/${slug}`,
          title: slug,
          fullText: `${slug} body`,
          readingTimeMs: 0,
          saveMode: "manual",
        },
        [`${slug} body`],
      );
      await repo.updatePage(page.id, { status: "ready" });
      return page;
    };

    const noChunks = await makeReadyPage("no-chunks");
    await chunkRepo.deleteForPage(noChunks.id);
    const noEmbedding = await makeReadyPage("no-embedding");
    const staleModel = await makeReadyPage("stale-model");
    await chunkRepo.commitProcessedPage(
      staleModel.id,
      [{ text: "stale model", embedding: Float32Array.from([1]), tokenCount: 2 }],
      "old-model",
      { status: "ready" },
      2,
    );
    const staleVersion = await makeReadyPage("stale-version");
    await chunkRepo.commitProcessedPage(
      staleVersion.id,
      [{ text: "stale version", embedding: Float32Array.from([1]), tokenCount: 2 }],
      "current-model",
      { status: "ready" },
      1,
    );
    const current = await makeReadyPage("current");
    await chunkRepo.commitProcessedPage(
      current.id,
      [{ text: "current", embedding: Float32Array.from([1]), tokenCount: 1 }],
      "current-model",
      { status: "ready" },
      2,
    );
    const keywordOnly = await repo.commitCapturedPage(
      {
        url: "https://example.test/keyword-only",
        title: "keyword-only",
        fullText: "keyword-only body",
        readingTimeMs: 0,
        saveMode: "manual",
      },
      ["keyword-only body"],
    );

    const candidates = await repo.pageIdsNeedingSemanticIndex("current-model", 2);

    expect(new Set(candidates)).toEqual(
      new Set([noChunks.id, noEmbedding.id, staleModel.id, staleVersion.id]),
    );
    expect(candidates).not.toContain(current.id);
    expect(candidates).not.toContain(keywordOnly.id);
  });

  describe("excerpt derivation", () => {
    it("returns an empty excerpt for empty or whitespace-only text", () => {
      expect(deriveExcerpt("")).toBe("");
      expect(deriveExcerpt("   \n\t   \n ")).toBe("");
    });

    it("collapses whitespace runs into single spaces and trims", () => {
      expect(deriveExcerpt("  React   hooks\n\n  quick   reference  ")).toBe(
        "React hooks quick reference",
      );
    });

    it("returns text at or under the 240-char cap unchanged", () => {
      const short = "IndexedDB stores structured data.";
      expect(deriveExcerpt(short)).toBe(short);

      const exactCap = "a".repeat(240);
      expect(deriveExcerpt(exactCap)).toBe(exactCap);
    });

    it("cuts over-cap text at the last word boundary within the cap", () => {
      // 11-char pattern; usable boundaries at indices 10, 21, ... — the last
      // one within the cap sits at 230.
      const fullText = "abcdefghij ".repeat(30);

      const excerpt = deriveExcerpt(fullText);

      expect(excerpt).toBe("abcdefghij ".repeat(20) + "abcdefghij");
      expect(excerpt.length).toBeLessThanOrEqual(240);
      expect(excerpt.endsWith(" ")).toBe(false);
    });

    it("hard-cuts a long unbroken token at the cap instead of a near-empty excerpt", () => {
      expect(deriveExcerpt("x".repeat(500))).toBe("x".repeat(240));

      // The only boundary (index 5) sits far below the minimum usable cut.
      expect(deriveExcerpt(`intro ${"y".repeat(400)}`)).toBe(`intro ${"y".repeat(234)}`);
    });

    it("listPages derives excerpt from fullText without persisting it", async () => {
      const fullText = `${"useMemo caches expensive results ".repeat(20)}tail`;
      const saved = await repo.upsertCapturedPage({
        url: "https://react.dev/reference/react/useMemo",
        title: "useMemo",
        fullText,
        readingTimeMs: 1000,
        saveMode: "manual",
      });

      const [item] = await repo.listPages({ limit: 10 });

      expect(item).toBeDefined();
      expect(item?.excerpt).toBe(deriveExcerpt(fullText));
      expect(item?.excerpt.length).toBeLessThanOrEqual(240);
      expect(fullText.startsWith(item?.excerpt ?? "")).toBe(true);

      const record = await repo.getById(saved.id);
      expect(record).toMatchObject({ id: saved.id, fullText });
      expect(record).not.toHaveProperty("excerpt");
    });
  });
});
