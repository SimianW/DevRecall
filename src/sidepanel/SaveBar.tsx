import { useCallback, useEffect, useRef, useState } from "react";

import type { DevRecallResponse, WorkerBroadcast } from "../shared/messages";
import { requireResponse, sendRequest, subscribeToBroadcasts } from "../ui/rpc";

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
  await requireResponse({ type: "page.save", payload: { tabId } }, "page.saved");
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

function isCapturableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);

  // Guards overlapping refreshes: only the most recent call may commit state,
  // so out-of-order resolutions can't clobber newer tab/status pairs.
  const refreshSeq = useRef(0);
  const activeTabRef = useRef<ActiveTab | null>(null);
  const saveSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    let nextTab: ActiveTab | null = null;
    try {
      nextTab = await getActiveTab();
      const nextStatus =
        nextTab && isCapturableUrl(nextTab.url)
          ? await loadUrlStatus(nextTab.url)
          : ({ saved: false } satisfies UrlStatus);
      if (seq !== refreshSeq.current) {
        return; // a newer refresh superseded us
      }
      activeTabRef.current = nextTab;
      setTab(nextTab);
      setUrlStatus(nextStatus);
      setRefreshError(null);
    } catch (error) {
      if (seq !== refreshSeq.current) {
        return;
      }
      // Keep the tab identity, but discard its status: stale status from a
      // previous tab must never enable a save action for the wrong URL.
      activeTabRef.current = nextTab;
      setTab(nextTab);
      setUrlStatus({ saved: false });
      setRefreshError(error instanceof Error ? error.message : "Could not refresh this page");
    } finally {
      if (seq === refreshSeq.current) {
        setInitialLoading(false);
      }
    }
  }, [getActiveTab, loadUrlStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The worker broadcasts page.updated as processing progresses; re-resolve the
  // status for the current tab instead of polling (the popup used a 2 s poll).
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (
        message.type === "page.updated" ||
        message.type === "page.removed" ||
        message.type === "library.cleared" ||
        message.type === "library.changed"
      ) {
        void refresh();
      }
    });
    return unsubscribe;
  }, [subscribe, refresh]);

  useEffect(() => {
    const unsubscribe = onTabChange(() => {
      saveSeq.current += 1;
      setSaving(false);
      setSaveFailed(false);
      setSaveError(null);
      void refresh();
    });
    return unsubscribe;
  }, [onTabChange, refresh]);

  const handleSave = async () => {
    const target = tab;
    if (!target || !isCapturableUrl(target.url)) return;
    const operation = ++saveSeq.current;
    setSaving(true);
    setSaveFailed(false);
    setSaveError(null);
    try {
      await saveTab(target.tabId);
      if (
        operation !== saveSeq.current ||
        activeTabRef.current?.tabId !== target.tabId ||
        activeTabRef.current.url !== target.url
      ) {
        return;
      }
      await refresh();
    } catch (error) {
      if (
        operation === saveSeq.current &&
        activeTabRef.current?.tabId === target.tabId &&
        activeTabRef.current.url === target.url
      ) {
        setSaveFailed(true);
        setSaveError(error instanceof Error ? error.message : "Save failed");
      }
    } finally {
      if (operation === saveSeq.current) {
        setSaving(false);
      }
    }
  };

  if (initialLoading) {
    return null;
  }

  if (refreshError) {
    return (
      <section className="rounded-md border border-default bg-surface-raised px-4 py-3">
        <p className="text-sm font-medium text-foreground">Could not refresh this page.</p>
        <p role="alert" className="mt-1 text-xs text-foreground/65">
          {refreshError}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white"
        >
          Retry
        </button>
      </section>
    );
  }

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
  const capturable = isCapturableUrl(tab.url);
  if (!capturable) {
    buttonLabel = "Save unavailable";
    disabled = true;
  } else if (saving) {
    buttonLabel = "Saving…";
    disabled = true;
  } else if (urlStatus.saved && urlStatus.status === "pending") {
    buttonLabel = "Processing…";
    disabled = true;
  } else if (urlStatus.saved && urlStatus.status === "keyword_ready") {
    buttonLabel = `Saved locally ✓ ${formatRelativeTime(urlStatus.savedAt)}`;
    disabled = true;
  } else if (urlStatus.saved && urlStatus.status === "enriching") {
    buttonLabel = "Adding AI features…";
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
      {!capturable ? (
        <p role="note" className="mt-2 text-xs text-foreground/65">
          Only HTTP and HTTPS pages can be saved.
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
          {saveError}
        </p>
      ) : null}
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
