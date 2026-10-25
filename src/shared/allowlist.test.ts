import { describe, expect, it } from "vitest";

import { ALLOWLIST_DISPLAY, PRIVATE_DOCS_HOSTS, isAllowlisted } from "./allowlist";

describe("isAllowlisted", () => {
  const shouldMatch = [
    "https://github.com/some/repo",
    "https://www.github.com/org",
    "https://GitHub.com/Case/Insensitive",
    "https://stackoverflow.com/questions/1234",
    "https://developer.mozilla.org/en-US/docs",
    "https://docs.example.com/guide",
    "https://docs.rs/serde",
    "https://docs.python.org/3/library/",
    "https://myproject.readthedocs.io/en/latest/",
    "https://www.npmjs.com/package/vite",
    "https://www.rust-lang.org/learn",
    "https://www.python.org/docs/",
    "http://docs.internal.example.com/",
    "https://github.com:443/org/repo",
  ];

  const shouldNotMatch = [
    "https://example.com/page",
    "https://twitter.com/user",
    "https://reddit.com/r/programming",
    "https://medium.com/article",
    // Lookalike hosts that only start with an allowlisted name.
    "https://github.com.evil.example/",
    "https://python.organic-shop.com/",
    "https://npmjs.com-mirror.example/package/vite",
    "https://notgithub.com/",
    // Allowlisted names outside the host.
    "https://example.com/?to=x.readthedocs.io",
    "https://evil.example/docs.example.com",
    "https://user:pass@evil.example/?github.com",
    "https://readthedocs.io.evil.example/",
    // Private document hosts under docs.*.
    "https://docs.google.com/document/d/abc/edit",
    "https://DOCS.GOOGLE.COM/spreadsheets/d/abc",
    "https://docs.google.com./document/d/abc/edit",
    "https://docs.qq.com/doc/abc",
    "https://docs.zoho.com/writer/abc",
    // Not http(s), or not a URL at all.
    "ftp://github.com/repo",
    "file:///home/docs.example.com",
    "not a url",
    "",
  ];

  it.each(shouldMatch)("matches allowlisted URL: %s", (url) => {
    expect(isAllowlisted(url)).toBe(true);
  });

  it.each(shouldNotMatch)("does not match: %s", (url) => {
    expect(isAllowlisted(url)).toBe(false);
  });
});

describe("ALLOWLIST_DISPLAY", () => {
  it("names every private docs host the docs.* rule excludes", () => {
    const docsEntry = ALLOWLIST_DISPLAY.find((entry) => entry.startsWith("docs.*"));

    expect(docsEntry).toBeDefined();
    for (const host of PRIVATE_DOCS_HOSTS) {
      expect(docsEntry).toContain(host);
    }
  });
});
