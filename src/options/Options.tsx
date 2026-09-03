import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { SurfaceShell } from "../ui/components";
import type { DevRecallResponse, WorkerBroadcast } from "../shared/messages";
import { sendRequest, subscribeToBroadcasts } from "../ui/rpc";
import { ALLOWLIST_DISPLAY } from "../shared/allowlist";

type SettingsStatusPayload = Extract<DevRecallResponse, { type: "settings.status" }>["payload"];
type ModeResult = Extract<DevRecallResponse, { type: "settings.mode" }>["payload"];
type StoredMode = ModeResult["storedMode"];
type EffectiveMode = ModeResult["effectiveMode"];
type StatusResult = Pick<SettingsStatusPayload, "hasApiKey"> &
  Partial<Pick<SettingsStatusPayload, "storedMode" | "effectiveMode" | "persistentStorage">>;
type PersistentStorageState = SettingsStatusPayload["persistentStorage"];
type TestResult = { success: boolean; message: string };
type StorageStats = { pageCount: number; totalTextBytes: number; pagesMissingEmbeddings: number };
type BulkOp = "enrich" | "semantic";
type BulkProgress = Extract<WorkerBroadcast, { type: "bulk.progress" }>["payload"];
type PreparedBatch = { batchId: string; count: number };

const MAX_INDEXED_DB_QUERY_LIMIT = 2 ** 32 - 1;

type OptionsProps = {
  loadStatus?: () => Promise<StatusResult>;
  saveApiKey?: (apiKey: string) => Promise<void>;
  removeApiKey?: () => Promise<void>;
  testConnection?: () => Promise<TestResult>;
  loadMode?: () => Promise<ModeResult | null>;
  setMode?: (mode: StoredMode) => Promise<ModeResult | null>;
  loadStorageStats?: () => Promise<StorageStats>;
  loadKeywordReadyCount?: () => Promise<number>;
  prepareBulkEnrich?: () => Promise<PreparedBatch>;
  prepareReindexSemantic?: () => Promise<PreparedBatch>;
  startBulkEnrich?: (batchId: string) => Promise<{ total: number }>;
  startReindexSemantic?: (batchId: string) => Promise<{ total: number }>;
  cancelBulk?: () => Promise<void>;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
  exportData?: () => Promise<string>;
  deleteAll?: () => Promise<void>;
  loadAutoSave?: () => Promise<boolean>;
  setAutoSave?: (enabled: boolean) => Promise<void>;
};

const defaultLoadStatus = async (): Promise<StatusResult> => {
  const response = await sendRequest({ type: "settings.getStatus" }, "settings.status");
  return response?.payload ?? { hasApiKey: false, storedMode: "hybrid", effectiveMode: "local" };
};

const defaultSaveApiKey = async (apiKey: string): Promise<void> => {
  await sendRequest({ type: "settings.setApiKey", payload: { apiKey } }, "settings.apiKeySet");
};

/** The RPC contract clears the key by storing an empty string. */
const defaultRemoveApiKey = async (): Promise<void> => {
  await sendRequest({ type: "settings.setApiKey", payload: { apiKey: "" } }, "settings.apiKeySet");
};

const defaultTestConnection = async (): Promise<TestResult> => {
  const response = await sendRequest(
    { type: "settings.testConnection" },
    "settings.connectionTestResult",
  );
  return response?.payload ?? { success: false, message: "Connection test unavailable" };
};

const defaultLoadMode = async (): Promise<ModeResult | null> => {
  const response = await sendRequest({ type: "settings.getMode" }, "settings.mode");
  return response?.payload ?? null;
};

const defaultSetMode = async (mode: StoredMode): Promise<ModeResult | null> => {
  const response = await sendRequest(
    { type: "settings.setMode", payload: { mode } },
    "settings.modeSet",
  );
  return response?.payload ?? null;
};

const defaultLoadStorageStats = async (): Promise<StorageStats> => {
  const response = await sendRequest({ type: "storage.getStats" }, "storage.stats");
  if (!response) {
    throw new Error("Storage stats unavailable");
  }
  return response.payload;
};

/**
 * Count pages sitting at status "keyword_ready". The RPC has no dedicated
 * count, so the UI requests every compact list item to keep confirmation exact.
 */
const defaultLoadKeywordReadyCount = async (): Promise<number> => {
  const response = await sendRequest(
    { type: "page.list", payload: { limit: MAX_INDEXED_DB_QUERY_LIMIT } },
    "page.listed",
  );
  return (response?.payload.pages ?? []).filter((page) => page.status === "keyword_ready").length;
};

/**
 * Ask the worker to freeze the candidate IDs for bulk enrichment. The returned
 * count and batch ID describe the exact set used after confirmation.
 */
const defaultPrepareBulkEnrich = async (): Promise<PreparedBatch> => {
  const response = await sendRequest(
    { type: "library.prepareBulkEnrich", payload: {} },
    "library.bulkEnrichPrepared",
  );
  if (!response) {
    throw new Error("Could not prepare bulk enrichment");
  }
  return response.payload;
};

/**
 * Ask the worker to freeze the candidate IDs for semantic re-indexing. The
 * returned count and batch ID describe the exact set used after confirmation.
 */
const defaultPrepareReindexSemantic = async (): Promise<PreparedBatch> => {
  const response = await sendRequest(
    { type: "library.prepareReindexSemantic", payload: {} },
    "library.reindexSemanticPrepared",
  );
  if (!response) {
    throw new Error("Could not prepare semantic re-index");
  }
  return response.payload;
};

const defaultStartBulkEnrich = async (batchId: string): Promise<{ total: number }> => {
  const response = await sendRequest(
    { type: "library.bulkEnrich", payload: { batchId } },
    "library.bulkEnrichStarted",
  );
  return response?.payload ?? { total: 0 };
};

const defaultStartReindexSemantic = async (batchId: string): Promise<{ total: number }> => {
  const response = await sendRequest(
    { type: "library.reindexSemantic", payload: { batchId } },
    "library.reindexSemanticStarted",
  );
  return response?.payload ?? { total: 0 };
};

const defaultCancelBulk = async (): Promise<void> => {
  await sendRequest({ type: "library.cancelBulk", payload: {} }, "library.bulkCanceled");
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

const MODE_LABELS: Record<EffectiveMode, string> = {
  local: "Local-only",
  hybrid: "Hybrid",
};

/**
 * A broadcast is terminal once cancellation was requested, every page was
 * processed, or nothing remains. The panel must keep rendering this final
 * payload until the user dismisses it or starts another batch.
 */
function isBulkProgressTerminal(progress: BulkProgress): boolean {
  return Boolean(progress.canceled || progress.remaining === 0 || progress.done >= progress.total);
}

function formatBulkTerminalText(progress: BulkProgress): string {
  const outcome = progress.canceled ? "Canceled" : "Completed";
  const pages = progress.total === 1 ? "page" : "pages";
  const notProcessed =
    progress.canceled && progress.remaining > 0
      ? ` ${progress.remaining} ${progress.remaining === 1 ? "was" : "were"} not processed.`
      : "";
  return `${outcome}. Processed ${progress.done} of ${progress.total} ${pages}.${notProcessed} ${progress.failed} failed.`;
}

export function Options({
  loadStatus = defaultLoadStatus,
  saveApiKey = defaultSaveApiKey,
  removeApiKey = defaultRemoveApiKey,
  testConnection = defaultTestConnection,
  loadMode = defaultLoadMode,
  setMode = defaultSetMode,
  loadStorageStats = defaultLoadStorageStats,
  loadKeywordReadyCount = defaultLoadKeywordReadyCount,
  prepareBulkEnrich = defaultPrepareBulkEnrich,
  prepareReindexSemantic = defaultPrepareReindexSemantic,
  startBulkEnrich = defaultStartBulkEnrich,
  startReindexSemantic = defaultStartReindexSemantic,
  cancelBulk = defaultCancelBulk,
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
  const [storedMode, setStoredMode] = useState<StoredMode | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<EffectiveMode | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [keywordReadyCount, setKeywordReadyCount] = useState<number | null>(null);
  const [preparedBulkEnrich, setPreparedBulkEnrich] = useState<PreparedBatch | null>(null);
  const [preparedReindexSemantic, setPreparedReindexSemantic] = useState<PreparedBatch | null>(
    null,
  );
  const [bulkOp, setBulkOp] = useState<BulkOp | null>(null);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [showEnrichConfirm, setShowEnrichConfirm] = useState(false);
  const [showSemanticConfirm, setShowSemanticConfirm] = useState(false);
  const [cancelingBulk, setCancelingBulk] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [persistentStorage, setPersistentStorage] = useState<PersistentStorageState>("unknown");

  const refreshMode = () => {
    loadMode()
      .then((mode) => {
        if (mode) {
          setStoredMode(mode.storedMode);
          setEffectiveMode(mode.effectiveMode);
        }
      })
      .catch(() => {});
  };

  const refreshCounts = () => {
    loadStorageStats()
      .then(setStorageStats)
      .catch(() => {});
    loadKeywordReadyCount()
      .then(setKeywordReadyCount)
      .catch(() => {});
  };

  useEffect(() => {
    loadAutoSave()
      .then(setAutoSaveEnabled)
      .catch(() => {});
  }, [loadAutoSave]);

  useEffect(() => {
    loadStatus().then((status) => {
      setKeySaved(status.hasApiKey);
      if (status.storedMode) setStoredMode(status.storedMode);
      if (status.effectiveMode) setEffectiveMode(status.effectiveMode);
      setPersistentStorage(status.persistentStorage ?? "unknown");
    });
  }, [loadStatus]);

  useEffect(() => {
    refreshMode();
  }, [loadMode]);

  useEffect(() => {
    refreshCounts();
  }, [loadStorageStats, loadKeywordReadyCount]);

  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === "bulk.progress" && message.payload.kind === bulkOp) {
        setBulkProgress(message.payload);
        // Keep the final payload visible: it renders as the terminal state.
        if (isBulkProgressTerminal(message.payload)) {
          setBulkOp(null);
          setCancelingBulk(false);
          refreshCounts();
        }
      }
    });
    return unsubscribe;
  }, [subscribe, loadStorageStats, loadKeywordReadyCount, bulkOp]);

  const handleToggleAutoSave = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    setAutoSaveEnabled(next);
    setAutoSave(next).catch(() => setAutoSaveEnabled(!next)); // roll back on failure
  };

  const handleToggleLocalOnly = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    if (storedMode == null) return;
    const previousMode = storedMode;
    const previousEffective = effectiveMode;
    const nextMode: StoredMode = next ? "local" : "hybrid";
    setStoredMode(nextMode); // optimistic; rolled back if the worker rejects
    setMode(nextMode)
      .then((result) => {
        if (result) {
          setStoredMode(result.storedMode);
          setEffectiveMode(result.effectiveMode);
        } else {
          setStoredMode(previousMode);
          setEffectiveMode(previousEffective);
        }
      })
      .catch(() => {
        setStoredMode(previousMode);
        setEffectiveMode(previousEffective);
      });
  };

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    await saveApiKey(apiKey.trim());
    setKeySaved(true);
    setApiKey(""); // clear input for security/ux
    setTestResult(null); // clear previous test results
    refreshMode(); // A saved key can make the stored Hybrid preference effective again.
  };

  const handleRemoveApiKey = async () => {
    setRemoveError(null);
    try {
      await removeApiKey();
      setShowRemoveConfirm(false);
      setTestResult(null);
      loadStatus()
        .then((status) => setKeySaved(Boolean(status.hasApiKey)))
        .catch(() => setKeySaved(false));
      refreshMode();
      refreshCounts();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Failed to remove API key");
    }
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

  const handleStartBulkEnrich = async () => {
    if (!preparedBulkEnrich) return;
    const preparation = preparedBulkEnrich;
    setShowEnrichConfirm(false);
    setPreparedBulkEnrich(null);
    setBulkError(null);
    setBulkOp("enrich");
    setBulkProgress({
      kind: "enrich",
      done: 0,
      total: preparation.count,
      failed: 0,
      remaining: preparation.count,
    });
    try {
      const { total } = await startBulkEnrich(preparation.batchId);
      setBulkProgress({ kind: "enrich", done: 0, total, failed: 0, remaining: total });
      if (total === 0) {
        setBulkOp(null);
        setBulkProgress(null);
        refreshCounts();
      }
    } catch (err) {
      setBulkOp(null);
      setBulkProgress(null);
      setBulkError(err instanceof Error ? err.message : "Could not start adding AI features");
    }
  };

  const handleStartReindexSemantic = async () => {
    if (!preparedReindexSemantic) return;
    const preparation = preparedReindexSemantic;
    setShowSemanticConfirm(false);
    setPreparedReindexSemantic(null);
    setBulkError(null);
    setBulkOp("semantic");
    setBulkProgress({
      kind: "semantic",
      done: 0,
      total: preparation.count,
      failed: 0,
      remaining: preparation.count,
    });
    try {
      const { total } = await startReindexSemantic(preparation.batchId);
      setBulkProgress({ kind: "semantic", done: 0, total, failed: 0, remaining: total });
      if (total === 0) {
        setBulkOp(null);
        setBulkProgress(null);
        refreshCounts();
      }
    } catch (err) {
      setBulkOp(null);
      setBulkProgress(null);
      setBulkError(err instanceof Error ? err.message : "Could not start re-indexing");
    }
  };

  const handleCancelBulk = async () => {
    setCancelingBulk(true);
    setBulkError(null);
    try {
      // The ack only means cancellation was requested. The runner sends the
      // canceled broadcast after the in-flight page finishes; clear state there.
      await cancelBulk();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Could not cancel the operation");
      setCancelingBulk(false);
    }
  };

  const handleDismissBulk = () => {
    setBulkProgress(null);
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
      refreshCounts();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const bulkBusy = bulkOp != null;
  const bulkTerminal = bulkProgress != null && isBulkProgressTerminal(bulkProgress);
  const bulkTerminalText = bulkProgress != null ? formatBulkTerminalText(bulkProgress) : "";
  const enrichCount = keywordReadyCount ?? 0;
  const semanticCount = storageStats?.pagesMissingEmbeddings ?? 0;
  const modeLabel = effectiveMode == null ? "Loading..." : MODE_LABELS[effectiveMode];

  return (
    <SurfaceShell title="DevRecall Settings">
      <form
        className="mx-auto flex max-w-2xl flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        <section className="rounded-md border border-default bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-foreground">Search mode</h2>
          <p className="mt-2 text-sm text-foreground/65">
            Current mode:{" "}
            <span className="font-medium text-foreground/85" data-testid="search-mode-indicator">
              {modeLabel}
            </span>
          </p>
          <label className="mt-3 flex items-center gap-3 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={!keySaved || storedMode === "local"}
              onChange={handleToggleLocalOnly}
              disabled={storedMode == null || !keySaved}
              className="h-4 w-4 accent-accent"
            />
            Local-only mode
          </label>
          {!keySaved && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              Add an API key to use AI features.
            </p>
          )}
          <p className="mt-2 text-sm text-foreground/65">
            Pages stay in this browser. DevRecall uses keyword search and does not automatically
            contact OpenAI. Content is sent to OpenAI only when you explicitly choose Add AI
            features for one or more saved pages.
          </p>
        </section>

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
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={!keySaved || testing}
              onClick={handleTestConnection}
              className="w-fit rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10 disabled:bg-foreground/5 disabled:text-foreground/40 disabled:hover:bg-foreground/5"
            >
              {testing ? "Testing..." : "Test connection"}
            </button>
            {keySaved && (
              <button
                type="button"
                onClick={() => {
                  setShowRemoveConfirm(true);
                  setRemoveError(null);
                }}
                className="rounded-md bg-red-500/10 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-500/15 dark:text-red-300"
              >
                Remove API key
              </button>
            )}
          </div>
          {testResult && (
            <p
              className={`text-sm ${testResult.success ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}
            >
              {testResult.message}
            </p>
          )}
        </div>

        {showRemoveConfirm && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-sm text-amber-900 dark:text-amber-200">
              Remove the saved API key? Your saved pages and their metadata (titles, summaries,
              topics, technologies) are preserved. Nothing in your library is deleted. Search
              switches to local keyword-only mode, and DevRecall will no longer contact OpenAI
              automatically.
            </p>
            <div className="mt-3 flex gap-3">
              <button
                type="button"
                onClick={handleRemoveApiKey}
                className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
              >
                Remove key
              </button>
              <button
                type="button"
                onClick={() => setShowRemoveConfirm(false)}
                className="rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10"
              >
                Cancel
              </button>
            </div>
            {removeError && (
              <p className="mt-2 text-sm text-red-700 dark:text-red-300">{removeError}</p>
            )}
          </div>
        )}

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
          <h2 className="text-sm font-semibold text-foreground">Keyboard shortcuts</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground/75">
            <li>Toggle DevRecall side panel</li>
            <li>Save current page to DevRecall</li>
          </ul>
          <p className="mt-2 text-sm text-foreground/65">
            Neither shortcut has a default binding. Assign them by opening{" "}
            <span className="font-medium text-foreground/80">chrome://extensions/shortcuts</span> in
            Chrome and finding DevRecall.
          </p>
        </section>

        <section className="rounded-md border border-default bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-foreground">AI features</h2>
          <p className="mt-2 text-sm text-foreground/65">
            AI features are opt-in: summaries, tags, and meaning-based search are only generated
            when you ask for them. Adding AI features sends full page text to OpenAI. Semantic
            re-indexing sends the relevant text chunks.
          </p>

          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={async () => {
                setBulkError(null);
                try {
                  setPreparedBulkEnrich(await prepareBulkEnrich());
                  setShowEnrichConfirm(true);
                } catch (error) {
                  setBulkError(
                    error instanceof Error ? error.message : "Could not prepare bulk enrichment",
                  );
                }
              }}
              disabled={!keySaved || bulkBusy || enrichCount === 0}
              className="rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10 disabled:bg-foreground/5 disabled:text-foreground/40 disabled:hover:bg-foreground/5"
            >
              {bulkOp === "enrich" && bulkProgress
                ? `Adding AI features ${bulkProgress.done} / ${bulkProgress.total}...`
                : `Add AI features to local pages${enrichCount > 0 ? ` (${enrichCount})` : ""}`}
            </button>
            <button
              type="button"
              onClick={async () => {
                setBulkError(null);
                try {
                  setPreparedReindexSemantic(await prepareReindexSemantic());
                  setShowSemanticConfirm(true);
                } catch (error) {
                  setBulkError(
                    error instanceof Error ? error.message : "Could not prepare semantic re-index",
                  );
                }
              }}
              disabled={!keySaved || bulkBusy || semanticCount === 0}
              className="rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10 disabled:bg-foreground/5 disabled:text-foreground/40 disabled:hover:bg-foreground/5"
            >
              {bulkOp === "semantic" && bulkProgress
                ? `Re-indexing ${bulkProgress.done} / ${bulkProgress.total}...`
                : `Re-index semantic search${semanticCount > 0 ? ` (${semanticCount})` : ""}`}
            </button>
          </div>

          {bulkProgress && (
            <div className="mt-3 rounded-md border border-default/80 bg-foreground/[0.025] p-3">
              <p className="text-xs text-foreground/65" aria-live="polite">
                {bulkTerminal
                  ? bulkTerminalText
                  : `Completed ${bulkProgress.done} of ${bulkProgress.total}. Current ${Math.min(
                      bulkProgress.done + 1,
                      bulkProgress.total,
                    )}. Remaining ${bulkProgress.remaining}. Failed ${bulkProgress.failed}.`}
              </p>
              {bulkTerminal ? (
                <button
                  type="button"
                  onClick={handleDismissBulk}
                  className="mt-2 text-xs font-medium text-foreground/80 hover:underline"
                >
                  Dismiss
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCancelBulk}
                  disabled={cancelingBulk}
                  className="mt-2 text-xs font-medium text-red-700 hover:underline disabled:text-foreground/35 dark:text-red-300"
                >
                  {cancelingBulk ? "Canceling..." : "Cancel"}
                </button>
              )}
            </div>
          )}
          {!keySaved && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              Add an API key to use AI features.
            </p>
          )}
          {bulkError && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{bulkError}</p>}

          <p className="mt-2 text-xs text-foreground/55">
            Add AI features to local pages generates summaries, tags, and embeddings for pages saved
            in local-only mode. Re-index semantic search re-embeds pages whose vector embeddings are
            missing or outdated (for example after a chunking change) so meaning-based search works
            again.
          </p>

          {showEnrichConfirm && preparedBulkEnrich && (
            <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="text-sm text-amber-900 dark:text-amber-200">
                Send {preparedBulkEnrich.count} {preparedBulkEnrich.count === 1 ? "page" : "pages"}{" "}
                to OpenAI? The full text of{" "}
                {preparedBulkEnrich.count === 1 ? "this page" : "each page"} will be sent to OpenAI
                to generate summaries, tags, and embeddings. Your pages stay saved in this browser
                either way.
              </p>
              <div className="mt-3 flex gap-3">
                <button
                  type="button"
                  onClick={handleStartBulkEnrich}
                  className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                >
                  Add AI features
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowEnrichConfirm(false);
                    setPreparedBulkEnrich(null);
                  }}
                  className="rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {showSemanticConfirm && preparedReindexSemantic && (
            <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="text-sm text-amber-900 dark:text-amber-200">
                Re-index {preparedReindexSemantic.count}{" "}
                {preparedReindexSemantic.count === 1 ? "page" : "pages"}? Relevant text chunks will
                be sent to OpenAI to repair semantic search. Existing summaries, tags, technologies,
                platforms, and content types will stay unchanged.
              </p>
              <div className="mt-3 flex gap-3">
                <button
                  type="button"
                  onClick={handleStartReindexSemantic}
                  className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                >
                  Re-index semantic search
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowSemanticConfirm(false);
                    setPreparedReindexSemantic(null);
                  }}
                  className="rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/10"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-md border border-default bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-foreground">Storage</h2>
          <p className="mt-2 text-sm text-foreground/65">
            {storageStats == null
              ? "Loading..."
              : `${storageStats.pageCount} ${storageStats.pageCount === 1 ? "page" : "pages"}, ${(storageStats.totalTextBytes / 1_048_576).toFixed(2)} MB`}
          </p>
          <p className="mt-1 text-sm text-foreground/65">
            Browser storage protection:{" "}
            {persistentStorage === "granted"
              ? "Granted"
              : persistentStorage === "denied"
                ? "Not granted"
                : "Unknown"}
          </p>
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
