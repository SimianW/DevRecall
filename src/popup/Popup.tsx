import { useState } from "react";

import type { DevRecallRequest } from "../shared/messages";
import { SurfaceShell } from "../ui/components";

type SaveState = "idle" | "saving" | "saved" | "failed";

type PopupProps = {
  openSidePanel?: () => void;
  saveCurrentPage?: () => Promise<void>;
};

function defaultOpenSidePanel() {
  if (typeof chrome === "undefined" || !chrome.sidePanel?.open) {
    return;
  }

  void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
}

async function defaultSaveCurrentPage() {
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

  await chrome.runtime.sendMessage(request);
}

export function Popup({
  openSidePanel = defaultOpenSidePanel,
  saveCurrentPage = defaultSaveCurrentPage,
}: PopupProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");

  async function handleSave() {
    setSaveState("saving");

    try {
      await saveCurrentPage();
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  }

  return (
    <SurfaceShell title="DevRecall">
      <div className="flex min-h-[180px] flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-slate-900">Current page</p>
          <p className="mt-1 truncate text-sm text-slate-500">
            Ready to save into your library
          </p>
        </div>

        <button
          type="button"
          disabled={saveState === "saving"}
          onClick={handleSave}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300 disabled:text-slate-600"
        >
          {saveState === "saving"
            ? "Saving..."
            : saveState === "saved"
              ? "Saved"
              : "Save this page"}
        </button>

        {saveState === "failed" ? (
          <p className="text-xs text-red-600">Failed to save page</p>
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
