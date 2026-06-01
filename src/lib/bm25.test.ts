import { describe, expect, it } from "vitest";

import { bm25Search, tokenize } from "./bm25";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, and drops stopwords", () => {
    // After stemming: horizontal→horizont, autoscaler→autoscal, scales→scale, pods→pod
    expect(tokenize("The Horizontal-Pod Autoscaler scales PODS!")).toEqual([
      "horizont",
      "pod",
      "autoscal",
      "scale",
      "pod",
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
    // "pods" is stemmed to "pod" in both query and document
    expect(hits[0].matchedTerms).toContain("pod");
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

describe("tokenize stemming", () => {
  it("stems reporting and report to the same token", () => {
    expect(tokenize("reporting")).toEqual(tokenize("report"));
  });

  it("stems stakeholder and stakeholders to the same token", () => {
    expect(tokenize("stakeholder")).toEqual(tokenize("stakeholders"));
  });

  it("leaves CJK bigrams unchanged", () => {
    expect(tokenize("报告")).toEqual(["报告"]);
  });

  it("does not mangle short dev tokens", () => {
    expect(tokenize("css")).toContain("css");
    expect(tokenize("json")).toContain("json");
  });
});

describe("bm25 stemming recall", () => {
  it("matches stakeholder against stakeholders", () => {
    expect(bm25Search("stakeholder", ["...engaging stakeholders on scope..."])).toHaveLength(1);
  });

  it("matches reporting against report", () => {
    expect(bm25Search("reporting", ["...a one-pager report ..."])).toHaveLength(1);
  });
});

describe("tokenize — CJK support", () => {
  it("emits character bigrams for a Han run", () => {
    expect(tokenize("自动扩缩")).toEqual(["自动", "动扩", "扩缩"]);
  });

  it("emits a unigram for a single CJK character", () => {
    expect(tokenize("水")).toEqual(["水"]);
  });

  it("tokenizes mixed Latin + CJK text", () => {
    expect(tokenize("React 服务端渲染")).toEqual([
      "react",
      "服务",
      "务端",
      "端渲",
      "渲染",
    ]);
  });

  it("supports Hiragana, Katakana, and Hangul runs", () => {
    expect(tokenize("ひらがな")).toEqual(["ひら", "らが", "がな"]);
    expect(tokenize("カタカナ")).toEqual(["カタ", "タカ", "カナ"]);
    expect(tokenize("한국어")).toEqual(["한국", "국어"]);
  });

  it("preserves M4 Latin/stopword behavior", () => {
    expect(tokenize("The quick brown fox")).toEqual(["quick", "brown", "fox"]);
    // "hooks" is stemmed to "hook"
    expect(tokenize("React 18 hooks")).toEqual(["react", "18", "hook"]);
  });
});
