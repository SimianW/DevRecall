import { describe, expect, it } from "vitest";

import { dot } from "../../lib/vector";
import { ContentType } from "../../shared/enums";
import { MockLLMProvider } from "./MockLLMProvider";

describe("MockLLMProvider", () => {
  const provider = new MockLLMProvider();

  it("returns canned, valid tags", async () => {
    const result = await provider.summarizeAndTag(
      "body",
      "Title",
      "https://x.test",
      "sk",
      ContentType.Page,
    );

    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.contentType).toBe(ContentType.Documentation);
    expect(Array.isArray(result.topics)).toBe(true);
  });

  it("produces a normalized 1536-dim vector", async () => {
    const vector = await provider.embed("hello", "sk");

    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(1536);
    expect(dot(vector, vector)).toBeCloseTo(1, 5);
  });

  it("is deterministic for the same text", async () => {
    const a = await provider.embed("kubernetes autoscaling", "sk");
    const b = await provider.embed("kubernetes autoscaling", "sk");

    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces different vectors for different text", async () => {
    const [a, b] = await provider.embedBatch(["alpha", "beta"], "sk");

    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("exposes a mock model id", () => {
    expect(provider.embeddingModel).toBe("mock:embedding");
  });
});
