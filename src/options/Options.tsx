import { useEffect, useState } from "react";
import { SurfaceShell } from "../ui/components";
import type { DevRecallRequest, DevRecallResponse, WorkerBroadcast } from "../shared/messages";

type StatusResult = { hasApiKey: boolean };
type TestResult = { success: boolean; message: string };
type StorageStats = { pageCount: number; totalTextBytes: number; pagesMissingEmbeddings: number };

type OptionsProps = {
  loadStatus?: () => Promise<StatusResult>;
  saveApiKey?: (apiKey: string) => Promise<void>;
  testConnection?: () => Promise<TestResult>;
  loadStorageStats?: () => Promise<StorageStats>;
  startReindex?: () => Promise<{ total: number }>;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
};

const defaultLoadStatus = async (): Promise<StatusResult> => {
  const response = await chrome.runtime.sendMessage({ type: "settings.getStatus" });
  return response.payload;
};

const defaultSaveApiKey = async (apiKey: string): Promise<void> => {
  await chrome.runtime.sendMessage({
    type: "settings.setApiKey",
    payload: { apiKey },
  });
};

const defaultTestConnection = async (): Promise<TestResult> => {
  const response = await chrome.runtime.sendMessage({ type: "settings.testConnection" });
  return response.payload;
};

const defaultLoadStorageStats = async (): Promise<StorageStats> => {
  const response = await chrome.runtime.sendMessage({ type: "storage.getStats" });
  return response.payload;
};

const defaultStartReindex = async (): Promise<{ total: number }> => {
  const request: DevRecallRequest = { type: "library.reindex" };
  const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;
  return response.type === "library.reindexStarted" ? response.payload : { total: 0 };
};

const defaultSubscribe = (handler: (message: WorkerBroadcast) => void): (() => void) => {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
    return () => {};
  }
  const listener = (message: unknown) => handler(message as WorkerBroadcast);
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
};

export function Options({
  loadStatus = defaultLoadStatus,
  saveApiKey = defaultSaveApiKey,
  testConnection = defaultTestConnection,
  loadStorageStats = defaultLoadStorageStats,
  startReindex = defaultStartReindex,
  subscribe = defaultSubscribe,
}: OptionsProps) {
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    loadStatus().then((status) => {
      if (status.hasApiKey) {
        setKeySaved(true);
      }
    });
  }, [loadStatus]);

  useEffect(() => {
    loadStorageStats()
      .then(setStorageStats)
      .catch(() => {});
  }, [loadStorageStats]);

  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === "library.reindexProgress") {
        setProgress(message.payload);
        if (message.payload.done >= message.payload.total) {
          setReindexing(false);
          loadStorageStats().then(setStorageStats).catch(() => {});
        }
      }
    });
    return unsubscribe;
  }, [subscribe, loadStorageStats]);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    await saveApiKey(apiKey.trim());
    setKeySaved(true);
    setApiKey(""); // clear input for security/ux
    setTestResult(null); // clear previous test results
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection();
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const handleReindex = async () => {
    setReindexing(true);
    setProgress({ done: 0, total: 0 });
    try {
      const { total } = await startReindex();
      setProgress({ done: 0, total });
      if (total === 0) {
        setReindexing(false);
      }
    } catch {
      setReindexing(false);
    }
  };

  return (
    <SurfaceShell title="DevRecall Settings">
      <form
        className="mx-auto flex max-w-2xl flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        <label className="flex flex-col gap-2 text-sm font-medium text-slate-800">
          OpenAI API key
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keySaved ? "API key is set" : "sk-..."}
              className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={!apiKey.trim()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:bg-slate-300 disabled:text-slate-500"
            >
              Save
            </button>
          </div>
        </label>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!keySaved || testing}
            onClick={handleTestConnection}
            className="w-fit rounded-md bg-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {testing ? "Testing..." : "Test connection"}
          </button>
          {testResult && (
            <p className={`text-sm ${testResult.success ? "text-green-600" : "text-red-600"}`}>
              {testResult.message}
            </p>
          )}
        </div>

        <label className="flex items-center gap-3 text-sm font-medium text-slate-800">
          <input type="checkbox" disabled className="h-4 w-4 accent-accent" />
          Enable auto-save
        </label>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Keyboard shortcut</h2>
          <p className="mt-2 text-sm text-slate-500">
            <kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs">
              ⌘ Shift K
            </kbd>{" "}
            /{" "}
            <kbd className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 font-mono text-xs">
              Ctrl Shift K
            </kbd>{" "}
            opens the side panel. To customize, open{" "}
            <span className="font-medium text-slate-700">chrome://extensions/shortcuts</span>{" "}
            in Chrome and find DevRecall.
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Note: the shortcut opens the panel but cannot toggle it closed — this is a Chrome
            limitation.
          </p>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Storage</h2>
          <p className="mt-2 text-sm text-slate-500">
            {storageStats == null
              ? "Loading..."
              : `${storageStats.pageCount} ${storageStats.pageCount === 1 ? "page" : "pages"}, ${(storageStats.totalTextBytes / 1_048_576).toFixed(2)} MB`}
          </p>

          <button
            type="button"
            onClick={handleReindex}
            disabled={
              !keySaved || reindexing || (storageStats?.pagesMissingEmbeddings ?? 0) === 0
            }
            className="mt-3 rounded-md bg-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {reindexing && progress
              ? `Re-indexing ${progress.done} / ${progress.total}...`
              : `Re-index library${
                  storageStats && storageStats.pagesMissingEmbeddings > 0
                    ? ` (${storageStats.pagesMissingEmbeddings})`
                    : ""
                }`}
          </button>
          {!keySaved && (
            <p className="mt-1 text-xs text-amber-600">Set an API key to re-index.</p>
          )}
        </section>
      </form>
    </SurfaceShell>
  );
}
