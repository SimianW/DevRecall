import { Readability } from "@mozilla/readability";

import type { ContentExtractRequest, ContentExtractResponse } from "../shared/messages";
import type { ExtractedPage } from "../shared/types";

export function extractPage(
  doc: Document = document,
  clock: () => number = () => performance.now(),
): ExtractedPage {
  const article = new Readability(doc.cloneNode(true) as Document).parse();
  const fallbackText = doc.body?.innerText ?? doc.body?.textContent ?? "";
  const articleTitle = article?.title?.trim();
  const bodyText = article?.textContent ?? fallbackText;
  const fullText = collapseWhitespace(articleTitle ? `${articleTitle} ${bodyText}` : bodyText);

  if (fullText.length === 0) {
    throw new Error("No readable page text found");
  }

  return {
    url: doc.location.href,
    title: article?.title?.trim() || doc.title.trim() || "Untitled page",
    fullText,
    readingTimeMs: Math.round(clock()),
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The worker re-injects this script into tabs opened before install or update,
 * and Chrome can still run the manifest copy afterwards (e.g. while the page is
 * loading). The flag lives in this extension's isolated world, so each frame
 * registers the listener at most once.
 */
const LISTENER_FLAG = "__devrecallExtractListener";

function claimListener(): boolean {
  const scope = globalThis as typeof globalThis & { [LISTENER_FLAG]?: true };
  if (scope[LISTENER_FLAG]) {
    return false;
  }
  scope[LISTENER_FLAG] = true;
  return true;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage && claimListener()) {
  chrome.runtime.onMessage.addListener(
    (
      request: ContentExtractRequest,
      _sender,
      sendResponse: (response: ContentExtractResponse) => void,
    ) => {
      if (request.type !== "content.extract") {
        return false;
      }

      try {
        sendResponse({
          type: "content.extracted",
          payload: extractPage(),
        });
      } catch (error) {
        sendResponse({
          type: "content.extractFailed",
          payload: {
            message: error instanceof Error ? error.message : "Unknown extraction error",
          },
        });
      }

      return true;
    },
  );
}
