import { beforeEach, describe, expect, it, vi } from "vitest";

import { extractPage, handleContentScriptRequest } from "./extract";

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

    expect(() => extractPage(document, () => 1)).toThrow("No readable page text found");
  });

  it("shows shortcut results only in the top frame", () => {
    const showResult = vi.fn();
    const sendResponse = vi.fn();
    const request = { type: "manualSave.result", payload: { result: "saved" } } as const;

    handleContentScriptRequest(request, sendResponse, { isTopFrame: false, showResult });
    expect(showResult).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();

    handleContentScriptRequest(request, sendResponse, { isTopFrame: true, showResult });
    expect(showResult).toHaveBeenCalledWith("saved");
    expect(sendResponse).toHaveBeenCalledWith({ type: "manualSave.resultShown" });
  });
});
