import { beforeEach, describe, expect, it } from "vitest";

import { extractPage } from "./extract";

describe("extractPage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    // jsdom restricts pushState to same-origin URLs; a relative path works.
    window.history.pushState({}, "", "/docs?utm_source=test#top");
  });

  it("extracts title url fullText and reading time", () => {
    document.title = "Useful Docs";
    document.body.innerHTML = `
      <article>
        <h1>Useful Docs</h1>
        <p>This page explains an implementation detail.</p>
      </article>
    `;

    const result = extractPage(document, () => 1234.4);

    expect(result).toEqual({
      url: "http://localhost:3000/docs?utm_source=test#top",
      title: "Useful Docs",
      fullText: "Useful Docs This page explains an implementation detail.",
      readingTimeMs: 1234,
    });
  });

  it("throws when no readable text exists", () => {
    document.body.innerHTML = "<main></main>";

    expect(() => extractPage(document, () => 1)).toThrow(
      "No readable page text found",
    );
  });
});
