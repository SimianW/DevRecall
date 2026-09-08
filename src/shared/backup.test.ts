import { describe, expect, it } from "vitest";
import { parseBackup } from "./backup";
import { ContentType, Platform } from "./enums";

const page = {
  url: "https://example.com/docs",
  title: "Guide",
  fullText: "Useful content",
  summary: "A summary",
  topics: ["storage"],
  technologies: ["Dexie"],
  platform: Platform.Web,
  contentType: ContentType.Documentation,
  intent: "reference",
  savedAt: 1,
  visitedAt: 2,
  readingTimeMs: 10,
  saveMode: "manual",
};

describe("parseBackup", () => {
  it("accepts an exported library and strips untrusted IDs and derived fields", () => {
    const backup = JSON.stringify({
      schemaVersion: 1,
      pages: [{ ...page, id: "collision", urlHash: "fake", status: "ready", domain: "fake" }],
    });
    expect(parseBackup(backup)).toEqual([page]);
  });

  it.each([
    "not json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ schemaVersion: 2, pages: [] }),
    JSON.stringify({ schemaVersion: 1, pages: [null] }),
    JSON.stringify({ schemaVersion: 1, pages: [{ ...page, fullText: 123 }] }),
    JSON.stringify({ schemaVersion: 1, pages: [{ ...page, topics: [123] }] }),
    JSON.stringify({ schemaVersion: 1, pages: [{ ...page, url: "javascript:alert(1)" }] }),
    JSON.stringify({
      schemaVersion: 1,
      pages: [{ ...page, url: "https://user:secret@example.com" }],
    }),
    JSON.stringify({ schemaVersion: 1, pages: [{ ...page, savedAt: -1 }] }),
  ])("rejects invalid backup input before any writes", (json) => {
    expect(() => parseBackup(json)).toThrow();
  });

  it("validates every page before returning a restore plan", () => {
    expect(() =>
      parseBackup(JSON.stringify({ schemaVersion: 1, pages: [page, { ...page, intent: "bad" }] })),
    ).toThrow("Page 2");
  });
});
