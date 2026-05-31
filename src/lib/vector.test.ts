import { describe, expect, it } from "vitest";

import { cosineTopK, dot, normalize } from "./vector";

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe("normalize", () => {
  it("produces a unit vector", () => {
    const result = normalize(vec([3, 4]));

    expect(dot(result, result)).toBeCloseTo(1, 6);
    expect(result[0]).toBeCloseTo(0.6, 6);
    expect(result[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves an all-zero vector at zero", () => {
    const result = normalize(vec([0, 0, 0]));

    expect(Array.from(result)).toEqual([0, 0, 0]);
  });
});

describe("dot", () => {
  it("equals cosine for normalized vectors", () => {
    const a = normalize(vec([1, 0]));
    const b = normalize(vec([1, 1]));

    expect(dot(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("is 1 for a normalized vector with itself", () => {
    const a = normalize(vec([2, -5, 1]));

    expect(dot(a, a)).toBeCloseTo(1, 6);
  });

  it("throws on length mismatch", () => {
    expect(() => dot(vec([1, 2]), vec([1, 2, 3]))).toThrow();
  });
});

describe("cosineTopK", () => {
  const query = normalize(vec([1, 0]));
  const items = [
    { id: "far", embedding: normalize(vec([0, 1])) }, // orthogonal → 0
    { id: "near", embedding: normalize(vec([1, 0.1])) }, // close → ~1
    { id: "mid", embedding: normalize(vec([1, 1])) }, // 45° → ~0.707
    { id: "novec" }, // no embedding → skipped
  ];

  it("ranks by similarity and keeps top-K", () => {
    const hits = cosineTopK(query, items, 2);

    expect(hits).toHaveLength(2);
    expect(items[hits[0].index].id).toBe("near");
    expect(items[hits[1].index].id).toBe("mid");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("skips items without an embedding", () => {
    const hits = cosineTopK(query, items, 10);

    expect(hits).toHaveLength(3); // "novec" excluded
    expect(hits.map((h) => items[h.index].id)).not.toContain("novec");
  });
});
