import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
} from "../shared/messages";
import type { PageListItem, PageRecord } from "../shared/types";
import { PageRepo } from "./repository/PageRepo";
import { CaptureService } from "./services/CaptureService";

type CapturePort = {
  save(tabId: number): Promise<PageRecord>;
};

type PageListPort = {
  listPages(input: { limit: number }): Promise<PageListItem[]>;
};

type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
};

const pageRepo = new PageRepo();
const defaultDeps: HandlerDeps = {
  captureService: new CaptureService(pageRepo),
  pageRepo,
};

export async function handleRequest(
  request: DevRecallRequest,
  deps: HandlerDeps = defaultDeps,
): Promise<DevRecallResponse> {
  switch (request.type) {
    case "devrecall.ping":
      return {
        type: "devrecall.pong",
        payload: {
          appName: APP_NAME,
          version: APP_VERSION,
        },
      };

    case "settings.getStatus":
      return {
        type: "settings.status",
        payload: {
          hasApiKey: false,
          persistentStorage: "unknown",
        },
      };

    case "page.save":
      return {
        type: "page.saved",
        payload: {
          page: toPageListItem(await deps.captureService.save(request.payload.tabId)),
        },
      };

    case "page.list":
      return {
        type: "page.listed",
        payload: {
          pages: await deps.pageRepo.listPages({
            limit: request.payload.limit,
          }),
        },
      };
  }
}

function toPageListItem(page: PageRecord): PageListItem {
  return {
    id: page.id,
    url: page.url,
    title: page.title,
    domain: page.domain,
    sourceType: page.sourceType,
    summary: page.summary,
    topics: page.topics,
    technologies: page.technologies,
    savedAt: page.savedAt,
    status: page.status,
  };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    console.info("[DevRecall] installed");
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (
      request: DevRecallRequest,
      _sender,
      sendResponse: (response: DevRecallResponse) => void,
    ) => {
      void handleRequest(request).then(sendResponse);
      return true;
    },
  );
}
