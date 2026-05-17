import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
} from "../shared/messages";

export async function handleRequest(
  request: DevRecallRequest,
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
      void handleRequest(request).then(sendResponse);
      return true;
    },
  );
}
