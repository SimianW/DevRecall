import { describe, expect, it } from "vitest";
import { getEncoding } from "js-tiktoken";

import { chunkTokens } from "./tokenChunking";

const enc = getEncoding("cl100k_base");

// A paragraph long enough to span several small windows.
const LONG_TEXT = (
  "DevRecall captures technical browsing sessions and lets developers retrieve " +
  "past documentation through natural-language search. It runs entirely on the " +
  "user's machine as a Chrome extension, summarizing and tagging each saved page " +
  "with a hosted language model and storing everything in IndexedDB. "
).repeat(4);

describe("chunkTokens", () => {
  it("returns a single chunk for short text with an exact token count", () => {
    const result = chunkTokens("hello world", { maxTokens: 500, overlap: 50 });

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("hello world");
    expect(result[0].tokenCount).toBe(enc.encode("hello world").length);
  });

  it("returns no chunks for blank or whitespace-only input", () => {
    expect(chunkTokens("", { maxTokens: 500, overlap: 50 })).toEqual([]);
    expect(chunkTokens("   \n\t ", { maxTokens: 500, overlap: 50 })).toEqual([]);
  });

  it("splits long text into overlapping token windows", () => {
    const maxTokens = 20;
    const overlap = 5;
    const step = maxTokens - overlap;

    const trimmed = LONG_TEXT.trim();
    const tokens = enc.encode(trimmed);
    expect(tokens.length).toBeGreaterThan(maxTokens); // fixture sanity

    const result = chunkTokens(trimmed, { maxTokens, overlap });

    // Reconstruct the expected windows the same way the implementation does.
    const expected: { text: string; tokenCount: number }[] = [];
    for (let start = 0; start < tokens.length; start += step) {
      const window = tokens.slice(start, start + maxTokens);
      expected.push({ text: enc.decode(window), tokenCount: window.length });
      if (start + maxTokens >= tokens.length) {
        break;
      }
    }

    expect(result).toEqual(expected);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("rejects invalid options", () => {
    expect(() => chunkTokens("x", { maxTokens: 0 })).toThrow();
    expect(() => chunkTokens("x", { maxTokens: 10, overlap: 10 })).toThrow();
    expect(() => chunkTokens("x", { maxTokens: 10, overlap: -1 })).toThrow();
  });
});
