import { describe, expect, it } from "vitest";

import { ContentType, Platform } from "../shared/enums";
import { classifyPage } from "./platformClassifier";

/** Classifies a URL using its own hostname as the domain (the common capture path). */
function classify(url: string) {
  return classifyPage(url, new URL(url).hostname);
}

describe("classifyPage — GitHub", () => {
  it("classifies issue detail pages as github + issue", () => {
    expect(classify("https://github.com/facebook/react/issues/27632")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Issue,
    });
  });

  it("classifies the issues list page as github + issue", () => {
    expect(classify("https://github.com/facebook/react/issues")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Issue,
    });
  });

  it("classifies pull request pages as github + pull_request", () => {
    expect(classify("https://github.com/vercel/next.js/pull/58175")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.PullRequest,
    });
  });

  it("classifies the pulls list page as github + page", () => {
    expect(classify("https://github.com/vercel/next.js/pulls")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Page,
    });
  });

  it("classifies a repo root as github + repository", () => {
    expect(classify("https://github.com/simon/DevRecall")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Repository,
    });
  });

  it("classifies other repo-scoped GitHub paths as github + page", () => {
    expect(classify("https://github.com/simon/DevRecall/tree/main/src/lib")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Page,
    });
    expect(classify("https://github.com/simon/DevRecall/blob/main/README.md")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Page,
    });
  });

  it("does not mistake GitHub navigation paths for repository roots", () => {
    for (const url of [
      "https://github.com/settings/profile",
      "https://github.com/topics/typescript",
      "https://github.com/marketplace/actions",
      "https://github.com/orgs/openai",
    ]) {
      expect(classify(url)).toEqual({
        platform: Platform.Github,
        contentType: ContentType.Page,
      });
    }
  });

  it("prefers issue over repository when both segments appear", () => {
    expect(classify("https://github.com/facebook/react/issues/27632#comment")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Issue,
    });
  });
});

describe("classifyPage — Stack Overflow", () => {
  it("classifies question pages as stackoverflow + question", () => {
    expect(
      classify("https://stackoverflow.com/questions/76126814/dexie-indexeddb-migration"),
    ).toEqual({
      platform: Platform.StackOverflow,
      contentType: ContentType.Question,
    });
  });

  it("classifies non-question stackoverflow pages as stackoverflow + page", () => {
    expect(classify("https://stackoverflow.com/tags/typescript")).toEqual({
      platform: Platform.StackOverflow,
      contentType: ContentType.Page,
    });
  });

  it("does not classify a stackoverflow-style path on another domain as stackoverflow", () => {
    expect(classify("https://example.com/questions/123/some-slug")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Page,
    });
  });
});

describe("classifyPage — documentation platforms", () => {
  it("classifies MDN as mdn + documentation", () => {
    expect(classify("https://developer.mozilla.org/en-US/docs/Web/API/fetch")).toEqual({
      platform: Platform.Mdn,
      contentType: ContentType.Documentation,
    });
  });

  it("classifies Read the Docs subdomains as readthedocs + documentation", () => {
    expect(classify("https://requests.readthedocs.io/en/latest/")).toEqual({
      platform: Platform.ReadTheDocs,
      contentType: ContentType.Documentation,
    });
  });

  it("classifies docs.python.org as python + documentation", () => {
    expect(classify("https://docs.python.org/3/library/asyncio.html")).toEqual({
      platform: Platform.Python,
      contentType: ContentType.Documentation,
    });
  });

  it("classifies doc.rust-lang.org as rust + documentation", () => {
    expect(classify("https://doc.rust-lang.org/std/vec/struct.Vec.html")).toEqual({
      platform: Platform.Rust,
      contentType: ContentType.Documentation,
    });
  });

  it("classifies kubernetes.io as web + documentation (no dedicated platform)", () => {
    expect(classify("https://kubernetes.io/docs/concepts/workloads/pods/")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Documentation,
    });
  });

  it("classifies react.dev as web + documentation", () => {
    expect(classify("https://react.dev/reference/react/useEffect")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Documentation,
    });
  });

  it("classifies nodejs.org as web + documentation", () => {
    expect(classify("https://nodejs.org/api/fs.html")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Documentation,
    });
  });

  it("classifies typescriptlang.org as web + documentation, including www subdomain", () => {
    expect(classify("https://typescriptlang.org/docs/handbook/2/types-from-classes.html")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Documentation,
    });
    expect(classify("https://www.typescriptlang.org/docs/handbook/intro.html")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Documentation,
    });
  });
});

describe("classifyPage — npm", () => {
  it("classifies package pages as npm + package", () => {
    expect(classify("https://www.npmjs.com/package/dexie")).toEqual({
      platform: Platform.Npm,
      contentType: ContentType.Package,
    });
  });

  it("classifies non-package npmjs.com pages as npm + page", () => {
    expect(classify("https://www.npmjs.com/search?q=dexie")).toEqual({
      platform: Platform.Npm,
      contentType: ContentType.Page,
    });
  });

  it("does not classify a /package path on another domain as npm", () => {
    expect(classify("https://example.com/package/dexie")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Page,
    });
  });
});

describe("classifyPage — default", () => {
  it("falls back to web + page for unknown domains", () => {
    expect(classify("https://blog.example.dev/some-post")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Page,
    });
    expect(classify("https://news.ycombinator.com/item?id=40123456")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Page,
    });
  });

  it("does not let a /issues path on a non-github domain trigger the github rule", () => {
    expect(classify("https://gitlab.com/gitlab-org/gitlab/-/issues/123")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Page,
    });
  });
});

describe("classifyPage — host and URL handling", () => {
  it("classifies GitHub subdomains as github + page", () => {
    expect(classify("https://gist.github.com/simon/abc123")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Page,
    });
  });

  it("uses the domain argument even when it disagrees with the URL host", () => {
    expect(classifyPage("https://example.com/owner/repo/issues/1", "github.com")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Issue,
    });
  });

  it("derives the host from the URL when domain is empty", () => {
    expect(classifyPage("https://stackoverflow.com/questions/1/a-b", "")).toEqual({
      platform: Platform.StackOverflow,
      contentType: ContentType.Question,
    });
  });

  it("falls back to web + page for an unparseable URL with no domain", () => {
    expect(classifyPage("not a url", "")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Page,
    });
  });

  it("falls back to web + page for an unparseable URL with an unknown domain", () => {
    expect(classifyPage("::::", "example.com")).toEqual({
      platform: Platform.Web,
      contentType: ContentType.Page,
    });
  });

  it("still returns the platform for an unparseable URL when the domain identifies it", () => {
    // No path to inspect, so the classifier cannot prove this is a repository root.
    expect(classifyPage("github.com/owner/repo", "github.com")).toEqual({
      platform: Platform.Github,
      contentType: ContentType.Page,
    });
  });

  it("is case-insensitive on the domain argument", () => {
    expect(classifyPage("https://stackoverflow.com/questions/1/a-b", "StackOverflow.COM")).toEqual({
      platform: Platform.StackOverflow,
      contentType: ContentType.Question,
    });
  });
});
