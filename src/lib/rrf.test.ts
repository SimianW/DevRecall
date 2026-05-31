import { describe, expect, it } from "vitest";

import { DEFAULT_RRF_K, matchReasonFor, reciprocalRankFusion } from "./rrf";

describe("reciprocalRankFusion", () => {
  it("scores a single-list id by its 1-based rank", () => {
    const fused = reciprocalRankFusion(["a", "b"], []);

    expect(fused.get("a")?.fused).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 9);
    expect(fused.get("b")?.fused).toBeCloseTo(1 / (DEFAULT_RRF_K + 2), 9);
    expect(fused.get("a")?.inKeyword).toBe(true);
    expect(fused.get("a")?.inVector).toBe(false);
  });

  it("sums contributions for an id present in both lists", () => {
    const fused = reciprocalRankFusion(["x"], ["x"]);
    const entry = fused.get("x");

    expect(entry?.fused).toBeCloseTo(2 / (DEFAULT_RRF_K + 1), 9);
    expect(entry?.inKeyword).toBe(true);
    expect(entry?.inVector).toBe(true);
  });

  it("ranks a both-lists id above single-list ids", () => {
    // "both" is rank 2 in each list; "kw" is rank 1 in keyword only.
    const fused = reciprocalRankFusion(["kw", "both"], ["vec", "both"]);

    const both = fused.get("both")?.fused ?? 0;
    const kw = fused.get("kw")?.fused ?? 0;
    const vec = fused.get("vec")?.fused ?? 0;

    expect(both).toBeGreaterThan(kw);
    expect(both).toBeGreaterThan(vec);
  });

  it("honors a custom k", () => {
    const fused = reciprocalRankFusion(["a"], [], 10);

    expect(fused.get("a")?.fused).toBeCloseTo(1 / 11, 9);
  });

  it("returns an empty map for two empty lists", () => {
    expect(reciprocalRankFusion([], []).size).toBe(0);
  });
});

describe("matchReasonFor", () => {
  it("maps membership flags to a reason", () => {
    expect(matchReasonFor({ inKeyword: true, inVector: true })).toBe("both");
    expect(matchReasonFor({ inKeyword: false, inVector: true })).toBe("vector");
    expect(matchReasonFor({ inKeyword: true, inVector: false })).toBe("keyword");
  });
});
