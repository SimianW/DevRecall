import { useCallback, useEffect, useRef, useState } from "react";

import type { DevRecallResponse, WorkerBroadcast } from "../shared/messages";
import { sendRequest, subscribeToBroadcasts } from "../ui/rpc";

export type UrlStatus = Extract<DevRecallResponse, { type: "page.urlStatus" }>["payload"];

type ActiveTab = { tabId: number; title: string; url: string };

type SaveBarProps = {
  getActiveTab?: () => Promise<ActiveTab | null>;
  saveTab?: (tabId: number) => Promise<void>;
  loadUrlStatus?: (url: string) => Promise<UrlStatus>;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
  onTabChange?: (handler: () => void) => () => void;
};

async function defaultGetActiveTab(): Promise<ActiveTab | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    return null;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== "number" || !tab.url) {
    return null;
  }
  return { tabId: tab.id, title: tab.title ?? tab.url, url: tab.url };
}

async function defaultSaveTab(tabId: number): Promise<void> {
  const response = await sendRequest({ type: "page.save", payload: { tabId } }, "page.saved");
  if (!response) {
    throw new Error("Save failed");
  }
}

async function defaultLoadUrlStatus(url: string): Promise<UrlStatus> {
  const response = await sendRequest(
    { type: "page.statusForUrl", payload: { url } },
    "page.urlStatus",
  );
  return response?.payload ?? { saved: false };
}

function defaultOnTabChange(handler: () => void): () => void {
  if (typeof chrome === "undefined" || !chrome.tabs?.onActivated) {
    return () => {};
  }
  const onActivated = () => handler();
  const onUpdated = (_tabId: number, changeInfo: { status?: string }) => {
    if (changeInfo.status === "complete") {
      handler();
    }
  };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
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

export function SaveBar({
  getActiveTab = defaultGetActiveTab,
  saveTab = defaultSaveTab,
  loadUrlStatus = defaultLoadUrlStatus,
  subscribe = subscribeToBroadcasts,
  onTabChange = defaultOnTabChange,
}: SaveBarProps) {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [urlStatus, setUrlStatus] = useState<UrlStatus>({ saved: false });
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // Guards overlapping refreshes: only the most recent call may commit state,
  // so out-of-order resolutions can't clobber newer tab/status pairs.
  const refreshSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const nextTab = await getActiveTab();
    const nextStatus: UrlStatus = nextTab ? await loadUrlStatus(nextTab.url) : { saved: false };
    if (seq !== refreshSeq.current) {
      return; // a newer refresh superseded us
    }
    setTab(nextTab);
    setUrlStatus(nextStatus);
  }, [getActiveTab, loadUrlStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The worker broadcasts page.updated as processing progresses; re-resolve the
  // status for the current tab instead of polling (the popup used a 2 s poll).
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === "page.updated" || message.type === "library.cleared") {
        void refresh();
      }
    });
    return unsubscribe;
  }, [subscribe, refresh]);

  useEffect(() => {
    const unsubscribe = onTabChange(() => {
      setSaving(false);
      setSaveFailed(false);
      void refresh();
    });
    return unsubscribe;
  }, [onTabChange, refresh]);

  const handleSave = async () => {
    if (!tab) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await saveTab(tab.tabId);
      await refresh();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (!tab) {
    return null;
  }

  let domain: string;
  try {
    domain = new URL(tab.url).hostname;
  } catch {
    domain = tab.url;
  }

  let buttonLabel: string;
  let disabled: boolean;
  if (saving) {
    buttonLabel = "Saving…";
    disabled = true;
  } else if (urlStatus.saved && urlStatus.status === "pending") {
    buttonLabel = "Processing…";
    disabled = true;
  } else if (urlStatus.saved && urlStatus.status === "ready") {
    buttonLabel = `Saved ✓ ${formatRelativeTime(urlStatus.savedAt)}`;
    disabled = true;
  } else if ((urlStatus.saved && urlStatus.status === "failed") || saveFailed) {
    buttonLabel = "Save failed — try again";
    disabled = false;
  } else {
    buttonLabel = "Save to library";
    disabled = false;
  }

  return (
    <section className="rounded-md border border-default bg-surface-raised px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground/55">
        Reading now
      </p>
      <p className="mt-1 truncate font-serif text-sm font-semibold text-foreground">{tab.title}</p>
      <p className="text-xs text-foreground/55">{domain}</p>
      <button
        type="button"
        disabled={disabled}
        onClick={handleSave}
        className="mt-2 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:bg-foreground/15 disabled:text-foreground/55 disabled:hover:bg-foreground/15"
      >
        {buttonLabel}
      </button>
    </section>
  );
}
