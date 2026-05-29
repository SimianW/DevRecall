import { useEffect, useState } from "react";

import type { DevRecallRequest, DevRecallResponse } from "../shared/messages";
import { SurfaceShell } from "../ui/components";

type SaveState = "idle" | "saving" | "saved" | "failed";

export type UrlStatus = Extract<DevRecallResponse, { type: "page.urlStatus" }>["payload"];

type PopupProps = {
  openSidePanel?: () => void;
  saveCurrentPage?: () => Promise<void>;
  checkApiKey?: () => Promise<boolean>;
  loadUrlStatus?: () => Promise<UrlStatus>;
};

async function defaultCheckApiKey(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return false;
  }
  const request: DevRecallRequest = { type: "settings.getStatus" };
  const response = (await chrome.runtime.sendMessage(request)) as Extract<
    DevRecallResponse,
    { type: "settings.status" }
  >;
  return response?.payload?.hasApiKey ?? false;
}

function defaultOpenSidePanel() {
  if (typeof chrome === "undefined" || !chrome.sidePanel?.open) {
    return;
  }

  void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
}

export async function defaultSaveCurrentPage() {
  if (
    typeof chrome === "undefined" ||
    !chrome.tabs?.query ||
    !chrome.runtime?.sendMessage
  ) {
    throw new Error("Chrome extension APIs are unavailable");
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (typeof tab?.id !== "number") {
    throw new Error("No active tab is available");
  }

  const request: DevRecallRequest = {
    type: "page.save",
    payload: { tabId: tab.id },
  };

  const response = (await chrome.runtime.sendMessage(request)) as
    | DevRecallResponse
    | undefined;

  if (response?.type === "error") {
    throw new Error(response.payload.message);
  }
}

async function defaultLoadUrlStatus(): Promise<UrlStatus> {
  if (
    typeof chrome === "undefined" ||
    !chrome.tabs?.query ||
    !chrome.runtime?.sendMessage
  ) {
    return { saved: false };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return { saved: false };

  const request: DevRecallRequest = {
    type: "page.statusForUrl",
    payload: { url: tab.url },
  };

  const response = (await chrome.runtime.sendMessage(request)) as Extract<
    DevRecallResponse,
    { type: "page.urlStatus" }
  >;

  return response?.payload ?? { saved: false };
}

function formatRelativeTime(savedAt: number): string {
  const seconds = Math.floor((Date.now() - savedAt) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function Popup({
  openSidePanel = defaultOpenSidePanel,
  saveCurrentPage = defaultSaveCurrentPage,
  checkApiKey = defaultCheckApiKey,
  loadUrlStatus = defaultLoadUrlStatus,
}: PopupProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [urlStatus, setUrlStatus] = useState<UrlStatus | null>(null);

  useEffect(() => {
    void checkApiKey().then(setHasApiKey);
  }, [checkApiKey]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function fetchStatus() {
      const status = await loadUrlStatus();
      setUrlStatus(status);

      if (status.saved && status.status === "pending") {
        if (!intervalId) {
          intervalId = setInterval(() => void fetchStatus(), 2000);
        }
      } else {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }
    }

    void fetchStatus();

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [loadUrlStatus]);

  async function handleSave() {
    setSaveState("saving");

    try {
      await saveCurrentPage();
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  }

  // Derive button label and disabled state from the behavior matrix
  let buttonLabel: string;
  let isSaveDisabled: boolean;

  const isLoading = hasApiKey === null;

  if (urlStatus !== null && urlStatus.saved) {
    if (urlStatus.status === "pending") {
      buttonLabel = "Processing...";
      isSaveDisabled = true;
    } else if (urlStatus.status === "ready") {
      buttonLabel = `Saved ✓ ${formatRelativeTime(urlStatus.savedAt)}`;
      isSaveDisabled = true;
    } else {
      // failed
      buttonLabel = "Save failed — try again";
      isSaveDisabled = isLoading || hasApiKey === false;
    }
  } else {
    // No record in DB — fall back to local saveState
    if (saveState === "saving") {
      buttonLabel = "Saving...";
      isSaveDisabled = true;
    } else if (saveState === "saved") {
      buttonLabel = "Saved";
      isSaveDisabled = false;
    } else {
      buttonLabel = "Save this page";
      isSaveDisabled = isLoading || hasApiKey === false;
    }
  }

  const showFailedError =
    saveState === "failed" && (urlStatus === null || !urlStatus.saved);

  return (
    <SurfaceShell title="DevRecall">
      <div className="flex min-h-[180px] flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-slate-900">Current page</p>
          <p className="mt-1 truncate text-sm text-slate-500">
            Ready to save into your library
          </p>
        </div>

        <div>
          <button
            type="button"
            disabled={isSaveDisabled}
            onClick={handleSave}
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300 disabled:text-slate-600"
          >
            {buttonLabel}
          </button>
          {hasApiKey === false && (
            <p className="mt-2 text-xs text-amber-600">Set API key in settings</p>
          )}
        </div>

        {showFailedError ? (
          <p className="text-xs text-red-600">Couldn't read this page — reload it and try again.</p>
        ) : (
          <p className="text-xs text-slate-500">
            Manual capture stores title, URL, and readable text.
          </p>
        )}

        <button
          type="button"
          onClick={openSidePanel}
          className="mt-auto w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
        >
          Open library
        </button>
      </div>
    </SurfaceShell>
  );
}
