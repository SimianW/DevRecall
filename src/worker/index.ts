import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
} from "../shared/messages";
import type { PageListItem, PageRecord } from "../shared/types";
import {
  testOpenAIConnection,
} from "./llm/OpenAIProvider";
import { PageRepo, toPageListItem } from "./repository/PageRepo";
import { CaptureService } from "./services/CaptureService";
import { ChromeApiKeyStore, type ApiKeyStore } from "./settings/ApiKeyStore";

type CapturePort = {
  save(tabId: number): Promise<PageRecord>;
  processPage(pageId: string, apiKey: string): Promise<PageRecord>;
};

type PageListPort = {
  listPages(input: { limit: number }): Promise<PageListItem[]>;
};

type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
  apiKeyStore: ApiKeyStore;
  testConnection: (
    apiKey: string,
  ) => Promise<{ success: boolean; message: string }>;
};

const pageRepo = new PageRepo();
const defaultDeps: HandlerDeps = {
  captureService: new CaptureService(pageRepo, undefined, pageRepo),
  pageRepo,
  apiKeyStore: new ChromeApiKeyStore(),
  testConnection: testOpenAIConnection,
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

    case "settings.getStatus": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      return {
        type: "settings.status",
        payload: {
          hasApiKey: apiKey !== null,
          persistentStorage: "unknown",
        },
      };
    }

    case "settings.setApiKey": {
      await deps.apiKeyStore.setApiKey(request.payload.apiKey);

      return { type: "settings.apiKeySet" };
    }

    case "settings.testConnection": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      if (!apiKey) {
        return {
          type: "settings.connectionTestResult",
          payload: { success: false, message: "No API key set" },
        };
      }

      const result = await deps.testConnection(apiKey);

      return {
        type: "settings.connectionTestResult",
        payload: result,
      };
    }

    case "page.save": {
      const page = await deps.captureService.save(request.payload.tabId);
      const apiKey = await deps.apiKeyStore.getApiKey();

      if (apiKey) {
        void deps.captureService
          .processPage(page.id, apiKey)
          .catch((error) => {
            console.error("[DevRecall] LLM processing error:", error);
          });
      }

      return {
        type: "page.saved",
        payload: {
          page: toPageListItem(page),
        },
      };
    }

    case "page.list":
      return {
        type: "page.listed",
        payload: {
          pages: await deps.pageRepo.listPages({
            limit: request.payload.limit,
          }),
        },
      };

    default:
      throw new Error(`Unhandled request type: ${(request as { type: string }).type}`);
  }
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
      void handleRequest(request).then(sendResponse).catch((error) => {
        console.error("[DevRecall] handler error:", error);
      });
      return true;
    },
  );
}
