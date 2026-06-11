import type { DevRecallRequest, DevRecallResponse, WorkerBroadcast } from "../shared/messages";
import { OpenAIProvider, testOpenAIConnection } from "./llm/OpenAIProvider";
import { ChunkRepo } from "./repository/ChunkRepo";
import { PageRepo, toPageListItem } from "./repository/PageRepo";
import { CaptureService } from "./services/CaptureService";
import {
  AutoSaveService,
  chromeAlarmPort,
  chromeSessionPort,
  chromeTabPort,
} from "./services/AutoSaveService";
import { RetrievalService } from "./services/RetrievalService";
import { ChromeApiKeyStore } from "./settings/ApiKeyStore";
import { ChromeAutoSaveSettingStore } from "./settings/AutoSaveSettingStore";
import { handleMessage, processPageInBackground, type HandlerDeps } from "./handlers";

function broadcast(message: WorkerBroadcast): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return;
  }
  // Fire-and-forget. With no open receiver, Chrome rejects with
  // "Receiving end does not exist" — harmless here, so swallow it.
  void chrome.runtime.sendMessage(message).catch(() => {});
}

const pageRepo = new PageRepo();
const chunkRepo = new ChunkRepo();
const openai = new OpenAIProvider();
const captureService = new CaptureService(pageRepo, undefined, pageRepo, openai, chunkRepo, openai);
const autoSaveSettings = new ChromeAutoSaveSettingStore();
const defaultDeps: HandlerDeps = {
  captureService,
  pageRepo,
  apiKeyStore: new ChromeApiKeyStore(),
  testConnection: testOpenAIConnection,
  retrievalService: new RetrievalService(chunkRepo, pageRepo, openai),
  broadcast,
  autoSaveSettings,
};

// ---------------------------------------------------------------------------
// Auto-save: alarm-driven dwell timer for allowlisted domains.
// MV3 note: the service worker is killed after ~30 s of inactivity.
// Listeners MUST be registered at the top level so they fire on every worker wake.
// ---------------------------------------------------------------------------
const autoSaveService = new AutoSaveService(
  chromeAlarmPort,
  chromeSessionPort,
  chromeTabPort,
  {
    saveAuto: async (tabId: number) => {
      const page = await captureService.save(tabId, "auto");
      defaultDeps.retrievalService.invalidate();
      broadcast({ type: "page.updated", payload: { page: toPageListItem(page) } });
      processPageInBackground(defaultDeps, page.id);
      return page;
    },
  },
  {
    getByUrlHash: (urlHash: string) => pageRepo.getByUrlHash(urlHash),
  },
  { isEnabled: () => autoSaveSettings.isEnabled() },
);

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    console.info("[DevRecall] installed");
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (request: DevRecallRequest, _sender, sendResponse: (response: DevRecallResponse) => void) => {
      void handleMessage(request, sendResponse, defaultDeps);
      return true;
    },
  );
}

if (typeof chrome !== "undefined" && chrome.sidePanel?.setPanelBehavior) {
  // Toolbar icon opens the side panel directly (no popup in v1.0).
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

if (typeof chrome !== "undefined" && chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "open-side-panel" && chrome.sidePanel?.open) {
      // Synchronous within the command gesture — no await before open().
      void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    }
  });
}

// ---------------------------------------------------------------------------
// Auto-save listeners — registered at the TOP LEVEL so they survive worker
// restarts (MV3: the worker re-runs top-level code on every wake event).
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.alarms?.onAlarm) {
  // chrome.alarms minimum granularity is 30 s on Chrome 120+.
  chrome.alarms.onAlarm.addListener((alarm) => {
    void autoSaveService.onAlarmFired(alarm.name);
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    void autoSaveService.onTabActivated(activeInfo.tabId);
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status && tab.url) {
      void autoSaveService.onTabUpdated(tabId, changeInfo.status, tab.url);
    }
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void autoSaveService.onTabRemoved(tabId);
  });
}
