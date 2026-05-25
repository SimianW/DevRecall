import { beforeEach, describe, expect, it } from "vitest";

import { DevRecallDatabase } from "./db";
import { PageRepo } from "./PageRepo";

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
      sourceType: "unknown",
      summary: "",
      topics: [],
      technologies: [],
      intent: "reference",
      fullText:
        "The HorizontalPodAutoscaler automatically updates workload resources.",
      readingTimeMs: 42_000,
      saveMode: "manual",
      status: "ready",
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

  it("lists pages newest first without fullText", async () => {
    await repo.upsertCapturedPage({
      url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API",
      title: "IndexedDB API",
      fullText: "IndexedDB stores structured data.",
      readingTimeMs: 3000,
      saveMode: "manual",
    });

    await repo.upsertCapturedPage({
      url: "https://stackoverflow.com/questions/1/example",
      title: "Example Stack Overflow answer",
      fullText: "A useful debugging note.",
      readingTimeMs: 4000,
      saveMode: "manual",
    });

    const pages = await repo.listPages({ limit: 10 });

    expect(pages.map((page) => page.title)).toEqual([
      "Example Stack Overflow answer",
      "IndexedDB API",
    ]);
    expect(pages[0]).not.toHaveProperty("fullText");
  });
});
