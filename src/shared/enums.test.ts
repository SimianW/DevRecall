import { describe, expect, it } from "vitest";

import {
  CONTENT_TYPE_VALUES,
  ContentType,
  isContentType,
  isPlatform,
  PLATFORM_VALUES,
  Platform,
} from "./enums";

describe("Platform", () => {
  it("has the expected members and lowercase string values", () => {
    expect(Platform.Github).toBe("github");
    expect(Platform.StackOverflow).toBe("stackoverflow");
    expect(Platform.Mdn).toBe("mdn");
    expect(Platform.Npm).toBe("npm");
    expect(Platform.ReadTheDocs).toBe("readthedocs");
    expect(Platform.Rust).toBe("rust");
    expect(Platform.Python).toBe("python");
    expect(Platform.Web).toBe("web");
  });

  it("exposes exactly 8 unique values", () => {
    expect(PLATFORM_VALUES).toHaveLength(8);
    expect(new Set(PLATFORM_VALUES).size).toBe(8);
  });
});

describe("ContentType", () => {
  it("has the expected members and lowercase string values", () => {
    expect(ContentType.Documentation).toBe("documentation");
    expect(ContentType.Issue).toBe("issue");
    expect(ContentType.PullRequest).toBe("pull_request");
    expect(ContentType.Repository).toBe("repository");
    expect(ContentType.Question).toBe("question");
    expect(ContentType.Article).toBe("article");
    expect(ContentType.Paper).toBe("paper");
    expect(ContentType.Course).toBe("course");
    expect(ContentType.Package).toBe("package");
    expect(ContentType.Page).toBe("page");
  });

  it("exposes exactly 10 unique values", () => {
    expect(CONTENT_TYPE_VALUES).toHaveLength(10);
    expect(new Set(CONTENT_TYPE_VALUES).size).toBe(10);
  });

  it("uses snake_case multi-word values, matching the legacy sourceType vocabulary", () => {
    expect(ContentType.PullRequest).toBe("pull_request");
    expect(ContentType.PullRequest).not.toContain("-");
  });
});

describe("isPlatform", () => {
  it("accepts every Platform value", () => {
    for (const value of PLATFORM_VALUES) {
      expect(isPlatform(value)).toBe(true);
    }
  });

  it("rejects non-members and non-strings", () => {
    expect(isPlatform("gitlab")).toBe(false);
    expect(isPlatform("GITHUB")).toBe(false);
    expect(isPlatform("")).toBe(false);
    expect(isPlatform(undefined)).toBe(false);
    expect(isPlatform(null)).toBe(false);
    expect(isPlatform(42)).toBe(false);
  });
});

describe("isContentType", () => {
  it("accepts every ContentType value", () => {
    for (const value of CONTENT_TYPE_VALUES) {
      expect(isContentType(value)).toBe(true);
    }
  });

  it("rejects non-members and non-strings", () => {
    expect(isContentType("blog")).toBe(false);
    expect(isContentType("official_docs")).toBe(false);
    expect(isContentType("DOCUMENTATION")).toBe(false);
    expect(isContentType("")).toBe(false);
    expect(isContentType(undefined)).toBe(false);
    expect(isContentType(null)).toBe(false);
    expect(isContentType({})).toBe(false);
  });
});

describe("Platform and ContentType namespaces do not overlap", () => {
  it("keeps the two vocabularies disjoint so a raw value can never satisfy both guards", () => {
    for (const platform of PLATFORM_VALUES) {
      expect(isContentType(platform)).toBe(false);
    }
    for (const contentType of CONTENT_TYPE_VALUES) {
      expect(isPlatform(contentType)).toBe(false);
    }
  });
});
