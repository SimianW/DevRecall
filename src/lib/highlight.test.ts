import { describe, expect, it } from "vitest";

import { highlightTerms } from "./highlight";

describe("highlightTerms", () => {
  it("wraps whole-word matches in <mark>, case-insensitively", () => {
    expect(highlightTerms("Auto scaling pods", ["auto", "pods"])).toBe(
      "<mark>Auto</mark> scaling <mark>pods</mark>",
    );
  });

  it("escapes HTML before inserting marks", () => {
    expect(highlightTerms("<script>pods</script>", ["pods"])).toBe(
      "&lt;script&gt;<mark>pods</mark>&lt;/script&gt;",
    );
  });

  it("returns escaped text unchanged when there are no terms", () => {
    expect(highlightTerms("a & b", [])).toBe("a &amp; b");
  });

  it("does not highlight partial-word matches", () => {
    expect(highlightTerms("autoscaler", ["auto"])).toBe("autoscaler");
  });

  it("highlights overlapping CJK bigram matches as one valid span", () => {
    expect(highlightTerms("使用自动扩缩功能", ["自动", "动扩", "扩缩"])).toBe(
      "使用<mark>自动扩缩</mark>功能",
    );
  });
});
