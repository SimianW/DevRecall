import { describe, expect, it } from "vitest";

import { bm25Search, tokenize } from "./bm25";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, and drops stopwords", () => {
    expect(tokenize("The Horizontal-Pod Autoscaler scales PODS!")).toEqual([
      "horizontal",
      "pod",
      "autoscaler",
      "scales",
      "pods",
    ]);
  });
});

describe("bm25Search", () => {
  const documents = [
    "horizontal pod autoscaler automatically scales pods",
    "react hydration mismatch during server side rendering",
    "general notes about deployments and services",
  ];

  it("returns an empty array for a blank query", () => {
    expect(bm25Search("   ", documents)).toEqual([]);
  });

  it("returns an empty array when there are no documents", () => {
    expect(bm25Search("pods", [])).toEqual([]);
  });

  it("ranks the matching document first and reports matched terms", () => {
    const hits = bm25Search("autoscale pods", documents);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].index).toBe(0);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].matchedTerms).toContain("pods");
  });

  it("excludes documents that contain no query term", () => {
    const hits = bm25Search("hydration", documents);

    expect(hits.map((hit) => hit.index)).toEqual([1]);
  });

  it("honors the topK option", () => {
    const hits = bm25Search("pods deployments services", documents, { topK: 1 });

    expect(hits).toHaveLength(1);
  });
});
