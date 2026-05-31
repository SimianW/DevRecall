import { describe, expect, it } from "vitest";

import { chunkText } from "./chunking";

describe("chunkText", () => {
  it("returns a single chunk when the text is shorter than the window", () => {
    expect(chunkText("alpha beta gamma")).toEqual(["alpha beta gamma"]);
  });

  it("returns an empty array for blank text", () => {
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("splits long text into overlapping windows", () => {
    const words = Array.from({ length: 5 }, (_, i) => `w${i}`).join(" ");

    const chunks = chunkText(words, { maxWords: 2, overlapWords: 1 });

    expect(chunks).toEqual(["w0 w1", "w1 w2", "w2 w3", "w3 w4"]);
  });

  it("collapses runs of whitespace into single spaces", () => {
    expect(chunkText("alpha   beta\n\ngamma")).toEqual(["alpha beta gamma"]);
  });

  it("rejects an overlap that is not smaller than the window", () => {
    expect(() => chunkText("a b c", { maxWords: 2, overlapWords: 2 })).toThrow(
      "overlapWords must be between 0 and maxWords",
    );
  });
});
