import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { SurfaceShell } from "../ui/components";
import type { WorkerBroadcast } from "../shared/messages";
import { sendRequest, subscribeToBroadcasts } from "../ui/rpc";
import { ALLOWLIST_DISPLAY } from "../shared/allowlist";

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
  exportData?: () => Promise<string>;
  deleteAll?: () => Promise<void>;
  loadAutoSave?: () => Promise<boolean>;
  setAutoSave?: (enabled: boolean) => Promise<void>;
};

const defaultLoadStatus = async (): Promise<StatusResult> => {
  const response = await sendRequest({ type: "settings.getStatus" }, "settings.status");
  return response?.payload ?? { hasApiKey: false };
};

const defaultSaveApiKey = async (apiKey: string): Promise<void> => {
  await sendRequest({ type: "settings.setApiKey", payload: { apiKey } }, "settings.apiKeySet");
};

const defaultTestConnection = async (): Promise<TestResult> => {
  const response = await sendRequest(
    { type: "settings.testConnection" },
    "settings.connectionTestResult",
  );
  return response?.payload ?? { success: false, message: "Connection test unavailable" };
};

const defaultLoadStorageStats = async (): Promise<StorageStats> => {
  const response = await sendRequest({ type: "storage.getStats" }, "storage.stats");
  if (!response) {
    throw new Error("Storage stats unavailable");
  }
  return response.payload;
};

const defaultStartReindex = async (): Promise<{ total: number }> => {
  const response = await sendRequest({ type: "library.reindex" }, "library.reindexStarted");
  return response?.payload ?? { total: 0 };
};

const defaultSubscribe = subscribeToBroadcasts;

const defaultExportData = async (): Promise<string> => {
  const response = await sendRequest({ type: "data.export" }, "data.exported");
  return response?.payload.json ?? "{}";
};

const defaultDeleteAll = async (): Promise<void> => {
  await sendRequest({ type: "data.deleteAll" }, "data.deletedAll");
};

const defaultLoadAutoSave = async (): Promise<boolean> => {
  const response = await sendRequest({ type: "settings.getAutoSave" }, "settings.autoSave");
  return response?.payload.enabled ?? false;
};

const defaultSetAutoSave = async (enabled: boolean): Promise<void> => {
  await sendRequest({ type: "settings.setAutoSave", payload: { enabled } }, "settings.autoSaveSet");
};

export function Options({
  loadStatus = defaultLoadStatus,
  saveApiKey = defaultSaveApiKey,
  testConnection = defaultTestConnection,
  loadStorageStats = defaultLoadStorageStats,
  startReindex = defaultStartReindex,
  subscribe = defaultSubscribe,
  exportData = defaultExportData,
  deleteAll = defaultDeleteAll,
  loadAutoSave = defaultLoadAutoSave,
  setAutoSave = defaultSetAutoSave,
}: OptionsProps) {
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);

  useEffect(() => {
    loadAutoSave()
      .then(setAutoSaveEnabled)
      .catch(() => {});
  }, [loadAutoSave]);

  const handleToggleAutoSave = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    setAutoSaveEnabled(next);
    setAutoSave(next).catch(() => setAutoSaveEnabled(!next)); // roll back on failure
  };

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
          loadStorageStats()
            .then(setStorageStats)
            .catch(() => {});
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

  const handleExportData = async () => {
    setExportError(null);
    try {
      const json = await exportData();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "devrecall-export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    }
  };

  const handleDeleteAll = async () => {
    setDeleteError(null);
    try {
      await deleteAll();
      setShowDeleteConfirm(false);
      setStorageStats(null);
      loadStorageStats()
        .then(setStorageStats)
        .catch(() => {});
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
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
        <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
          OpenAI API key
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keySaved ? "API key is set" : "sk-..."}
              className="flex-1 rounded-md border border-default bg-surface-raised px-3 py-2 text-sm text-foreground outline-none placeholder:text-foreground/45 focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={!apiKey.trim()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:bg-foreground/15 disabled:text-foreground/50 disabled:hover:bg-foreground/15"
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
            className="w-fit rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10 disabled:bg-foreground/5 disabled:text-foreground/40 disabled:hover:bg-foreground/5"
          >
            {testing ? "Testing..." : "Test connection"}
          </button>
          {testResult && (
            <p
              className={`text-sm ${testResult.success ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}
            >
              {testResult.message}
            </p>
          )}
        </div>

        <section className="rounded-md border border-default bg-surface-raised p-4">
          <label className="flex items-center gap-3 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={autoSaveEnabled}
              onChange={handleToggleAutoSave}
              className="h-4 w-4 accent-accent"
            />
            Enable auto-save
          </label>
          <p className="mt-2 text-sm text-foreground/65">
            When enabled, pages you read for 30+ seconds on these technical sites are saved
            automatically:
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {ALLOWLIST_DISPLAY.map((domain) => (
              <li
                key={domain}
                className="rounded-full border border-default/80 bg-foreground/5 px-2 py-1 text-xs text-foreground/75"
              >
                {domain}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-md border border-default bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-foreground">Keyboard shortcut</h2>
          <p className="mt-2 text-sm text-foreground/65">
            <kbd className="rounded border border-default bg-foreground/5 px-1 py-0.5 font-mono text-xs text-foreground/80">
              ⌘ Shift K
            </kbd>{" "}
            /{" "}
            <kbd className="rounded border border-default bg-foreground/5 px-1 py-0.5 font-mono text-xs text-foreground/80">
              Ctrl Shift K
            </kbd>{" "}
            opens the side panel. To customize, open{" "}
            <span className="font-medium text-foreground/80">chrome://extensions/shortcuts</span> in
            Chrome and find DevRecall.
          </p>
          <p className="mt-1 text-xs text-foreground/50">
            Note: the shortcut opens the panel but cannot toggle it closed — this is a Chrome
            limitation.
          </p>
        </section>

        <section className="rounded-md border border-default bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-foreground">Storage</h2>
          <p className="mt-2 text-sm text-foreground/65">
            {storageStats == null
              ? "Loading..."
              : `${storageStats.pageCount} ${storageStats.pageCount === 1 ? "page" : "pages"}, ${(storageStats.totalTextBytes / 1_048_576).toFixed(2)} MB`}
          </p>

          <button
            type="button"
            onClick={handleReindex}
            disabled={!keySaved || reindexing || (storageStats?.pagesMissingEmbeddings ?? 0) === 0}
            className="mt-3 rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10 disabled:bg-foreground/5 disabled:text-foreground/40 disabled:hover:bg-foreground/5"
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
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              Set an API key to re-index.
            </p>
          )}
        </section>

        <section className="rounded-md border border-default bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-foreground">Data Management</h2>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleExportData}
              className="rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10"
            >
              Export Data
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-md bg-red-500/10 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-500/15 dark:text-red-300"
            >
              Delete All Data
            </button>
          </div>
          {exportError && (
            <p className="mt-2 text-sm text-red-700 dark:text-red-300">{exportError}</p>
          )}

          {showDeleteConfirm && (
            <div className="mt-4 rounded-md border border-red-500/25 bg-red-500/10 p-4">
              <p className="text-sm text-red-800 dark:text-red-200">
                Are you sure you want to delete all saved pages? This cannot be undone.
              </p>
              <div className="mt-3 flex gap-3">
                <button
                  type="button"
                  onClick={handleDeleteAll}
                  className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10"
                >
                  Cancel
                </button>
              </div>
              {deleteError && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-300">{deleteError}</p>
              )}
            </div>
          )}
        </section>
      </form>
    </SurfaceShell>
  );
}
