import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerBroadcast } from "../shared/messages";
import { Options } from "./Options";

afterEach(() => {
  vi.unstubAllGlobals();
});

// NOTE: dark mode is media-based (tailwind darkMode: "media"). jsdom cannot
// compute colors or toggle a root `.dark` class, so visual contrast cannot be
// asserted in tests. The assertions below check that `dark:text-*` variant
// classes ARE PRESENT in the DOM — dropping one is a real regression that will
// fail a test. Visual contrast is verified by manual QA in both themes.

function makeSubscribe() {
  let handler: ((m: WorkerBroadcast) => void) | null = null;
  return {
    subscribe: (h: (m: WorkerBroadcast) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    emit: async (m: WorkerBroadcast) => {
      await act(async () => {
        handler?.(m);
      });
    },
  };
}

const renderOptions = (props: Partial<React.ComponentProps<typeof Options>> = {}) => {
  const defaultProps = {
    loadStatus: vi.fn().mockResolvedValue({
      hasApiKey: false,
      storedMode: "hybrid" as const,
      effectiveMode: "local" as const,
      persistentStorage: "unknown" as const,
    }),
    loadMode: vi.fn().mockResolvedValue({ storedMode: "hybrid", effectiveMode: "local" }),
    saveApiKey: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ success: true, message: "Connection successful" }),
    ...props,
  };

  return {
    ...render(<Options {...defaultProps} />),
    props: defaultProps,
    user: userEvent.setup(),
  };
};

describe("Options", () => {
  it("renders the settings form", async () => {
    renderOptions();

    expect(screen.getByRole("heading", { name: "DevRecall Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toHaveClass(
      "border-default",
      "bg-surface-raised",
      "text-foreground",
    );

    // Save button should be present and disabled
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // Test connection button present (also disabled initially)
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
  });

  it("shows whether browser storage protection was granted", async () => {
    renderOptions({
      loadStatus: vi.fn().mockResolvedValue({
        hasApiKey: false,
        persistentStorage: "granted",
      }),
    });

    expect(await screen.findByText("Browser storage protection: Granted")).toBeInTheDocument();
  });

  it("enables save button when API key is entered", async () => {
    const { user } = renderOptions();

    const input = screen.getByLabelText("OpenAI API key");
    const saveButton = screen.getByRole("button", { name: "Save" });

    expect(saveButton).toBeDisabled();
    await user.type(input, "sk-test-123");
    expect(saveButton).toBeEnabled();
  });

  it("saves an API key", async () => {
    const { user, props } = renderOptions();

    const input = screen.getByLabelText("OpenAI API key");
    const saveButton = screen.getByRole("button", { name: "Save" });

    await user.type(input, "sk-test-123");
    await user.click(saveButton);

    expect(props.saveApiKey).toHaveBeenCalledWith("sk-test-123");

    // test connection should now be enabled
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });

  it("tests connection and shows success", async () => {
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    });

    // Wait for the loadStatus to resolve and enable the button
    const testButton = await screen.findByRole("button", { name: "Test connection" });
    expect(testButton).toBeEnabled();

    await user.click(testButton);

    const message = await screen.findByText("Connection successful");
    expect(message).toBeInTheDocument();
  });

  it("shows error when connection test fails", async () => {
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
      testConnection: vi.fn().mockResolvedValue({ success: false, message: "Invalid API key" }),
    });

    const testButton = await screen.findByRole("button", { name: "Test connection" });
    await user.click(testButton);

    const message = await screen.findByText("Invalid API key");
    expect(message).toBeInTheDocument();
  });
});

describe("Local-only settings", () => {
  it("shows Local-only enabled and locked without a key", async () => {
    renderOptions();

    const toggle = await screen.findByRole("checkbox", { name: "Local-only mode" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId("search-mode-indicator")).toHaveTextContent("Local-only");
    expect(screen.getAllByText("Add an API key to use AI features.").length).toBeGreaterThan(0);
  });

  it("lets a user with a key switch from Local-only to Hybrid", async () => {
    const setMode = vi.fn().mockResolvedValue({ storedMode: "hybrid", effectiveMode: "hybrid" });
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({
        hasApiKey: true,
        storedMode: "local",
        effectiveMode: "local",
      }),
      loadMode: vi.fn().mockResolvedValue({ storedMode: "local", effectiveMode: "local" }),
      setMode,
    });

    const toggle = await screen.findByRole("checkbox", { name: "Local-only mode" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(setMode).toHaveBeenCalledWith("hybrid");
    await waitFor(() =>
      expect(screen.getByTestId("search-mode-indicator")).toHaveTextContent("Hybrid"),
    );
  });

  it("removes only the key and explains that saved data remains", async () => {
    const removeApiKey = vi.fn().mockResolvedValue(undefined);
    const setMode = vi.fn();
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({
        hasApiKey: true,
        storedMode: "hybrid",
        effectiveMode: "hybrid",
      }),
      loadMode: vi.fn().mockResolvedValue({ storedMode: "hybrid", effectiveMode: "hybrid" }),
      removeApiKey,
      setMode,
    });

    await user.click(await screen.findByRole("button", { name: "Remove API key" }));
    expect(screen.getByText(/saved pages and their metadata.*preserved/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    expect(removeApiKey).toHaveBeenCalledOnce();
    expect(setMode).not.toHaveBeenCalled();
  });

  it("uses the required local privacy explanation", () => {
    renderOptions();
    expect(
      screen.getByText(
        "Pages stay in this browser. DevRecall uses keyword search and does not automatically contact OpenAI. Content is sent to OpenAI only when you explicitly choose Add AI features for one or more saved pages.",
      ),
    ).toBeInTheDocument();
  });

  it("directs keyboard-shortcut setup to Chrome's shortcut controls", () => {
    renderOptions();
    const section = screen.getByRole("heading", { name: "Keyboard shortcut" }).closest("section");
    expect(section).toHaveTextContent(
      "Customize the keyboard shortcut by opening chrome://extensions/shortcuts in Chrome and finding DevRecall.",
    );
    expect(section).not.toHaveTextContent("Shift K");
    expect(section).not.toHaveTextContent("Shift+K");
    expect(section).not.toHaveTextContent("open the panel but not close it");
  });
});

describe("confirmed bulk AI operations", () => {
  const keyedStatus = {
    hasApiKey: true,
    storedMode: "local" as const,
    effectiveMode: "local" as const,
  };

  it("shows the exact enrichment count before starting", async () => {
    const startBulkEnrich = vi.fn().mockResolvedValue({ total: 3 });
    const prepareBulkEnrich = vi.fn().mockResolvedValue({ batchId: "batch-1", count: 3 });
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue(keyedStatus),
      loadKeywordReadyCount: vi.fn().mockResolvedValue(3),
      prepareBulkEnrich,
      startBulkEnrich,
    });

    await user.click(
      await screen.findByRole("button", { name: "Add AI features to local pages (3)" }),
    );
    expect(startBulkEnrich).not.toHaveBeenCalled();
    expect(screen.getByText(/Send 3 pages to OpenAI\?/)).toHaveTextContent("full text");
    await user.click(screen.getByRole("button", { name: "Add AI features" }));
    expect(startBulkEnrich).toHaveBeenCalledWith("batch-1");
  });

  it("uses an IndexedDB-compatible limit when counting local pages", async () => {
    const sendMessage = vi.fn().mockImplementation((request: { type: string }) => {
      if (request.type === "page.list") {
        return Promise.resolve({
          type: "page.listed",
          payload: { pages: [{ status: "keyword_ready" }] },
        });
      }
      return Promise.resolve(undefined);
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    renderOptions({
      loadStatus: vi.fn().mockResolvedValue(keyedStatus),
      loadKeywordReadyCount: undefined,
    });

    expect(
      await screen.findByRole("button", { name: "Add AI features to local pages (1)" }),
    ).toBeEnabled();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "page.list",
      payload: { limit: 2 ** 32 - 1 },
    });
  });

  it("cancels a running bulk operation", async () => {
    const cancelBulk = vi.fn().mockResolvedValue(undefined);
    const prepareBulkEnrich = vi.fn().mockResolvedValue({ batchId: "batch-2", count: 2 });
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue(keyedStatus),
      loadKeywordReadyCount: vi.fn().mockResolvedValue(2),
      prepareBulkEnrich,
      startBulkEnrich: vi.fn().mockResolvedValue({ total: 2 }),
      cancelBulk,
    });

    await user.click(
      await screen.findByRole("button", { name: "Add AI features to local pages (2)" }),
    );
    await user.click(screen.getByRole("button", { name: "Add AI features" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancelBulk).toHaveBeenCalledOnce();
  });
});

describe("bulk operation cancel and terminal states", () => {
  const keyedStatus = {
    hasApiKey: true,
    storedMode: "local" as const,
    effectiveMode: "local" as const,
  };
  const storageStats = { pageCount: 3, totalTextBytes: 100, pagesMissingEmbeddings: 2 };

  const bulkProps = () => ({
    loadStatus: vi.fn().mockResolvedValue(keyedStatus),
    loadKeywordReadyCount: vi.fn().mockResolvedValue(3),
    loadStorageStats: vi.fn().mockResolvedValue(storageStats),
    prepareBulkEnrich: vi.fn().mockResolvedValue({ batchId: "batch-t", count: 3 }),
    startBulkEnrich: vi.fn().mockResolvedValue({ total: 3 }),
  });

  const canceledBroadcast = {
    type: "bulk.progress" as const,
    payload: {
      kind: "enrich" as const,
      done: 1,
      total: 3,
      failed: 0,
      remaining: 2,
      canceled: true,
    },
  };

  async function startEnrichBatch(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      await screen.findByRole("button", { name: "Add AI features to local pages (3)" }),
    );
    await user.click(screen.getByRole("button", { name: "Add AI features" }));
  }

  it("keeps showing Canceling... after the cancel RPC resolves", async () => {
    let resolveCancel!: () => void;
    const cancelBulk = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const { subscribe } = makeSubscribe();
    const { user } = renderOptions({ ...bulkProps(), cancelBulk, subscribe });

    await startEnrichBatch(user);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Canceling..." })).toBeDisabled();

    resolveCancel();
    await act(async () => {});

    expect(cancelBulk).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Canceling..." })).toBeInTheDocument();
    expect(screen.queryByText(/^Canceled\./)).not.toBeInTheDocument();
  });

  it("shows a persistent canceled terminal state with Dismiss after the canceled broadcast", async () => {
    const { subscribe, emit } = makeSubscribe();
    const { user } = renderOptions({ ...bulkProps(), subscribe });

    await startEnrichBatch(user);
    await emit(canceledBroadcast);

    expect(
      screen.getByText("Canceled. Processed 1 of 3 pages. 2 were not processed. 0 failed."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("re-enables the batch buttons once the terminal state appears", async () => {
    const { subscribe, emit } = makeSubscribe();
    const { user } = renderOptions({ ...bulkProps(), subscribe });

    await startEnrichBatch(user);
    expect(screen.getByRole("button", { name: /^Re-index semantic search/ })).toBeDisabled();
    await emit(canceledBroadcast);

    expect(screen.getByRole("button", { name: /^Add AI features to local pages/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Re-index semantic search/ })).toBeEnabled();
  });

  it("clears the terminal state when Dismiss is clicked", async () => {
    const { subscribe, emit } = makeSubscribe();
    const { user } = renderOptions({ ...bulkProps(), subscribe });

    await startEnrichBatch(user);
    await emit(canceledBroadcast);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(/^Canceled\./)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("replaces the terminal state when a new batch starts", async () => {
    const { subscribe, emit } = makeSubscribe();
    const { user } = renderOptions({ ...bulkProps(), subscribe });

    await startEnrichBatch(user);
    await emit(canceledBroadcast);
    expect(screen.getByText(/^Canceled\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add AI features to local pages (3)" }));
    await user.click(screen.getByRole("button", { name: "Add AI features" }));

    expect(screen.queryByText(/^Canceled\./)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("keeps a visible completed terminal state after natural completion", async () => {
    const { subscribe, emit } = makeSubscribe();
    const { user } = renderOptions({ ...bulkProps(), subscribe });

    await startEnrichBatch(user);
    await emit({
      type: "bulk.progress",
      payload: { kind: "enrich", done: 3, total: 3, failed: 0, remaining: 0 },
    });

    expect(screen.getByText("Completed. Processed 3 of 3 pages. 0 failed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add AI features to local pages/ })).toBeEnabled();
  });

  it("uses the same terminal display when cancellation is driven by Local-only mode", async () => {
    const { subscribe, emit } = makeSubscribe();
    const { user } = renderOptions({ ...bulkProps(), subscribe });

    await startEnrichBatch(user);
    await emit({
      type: "bulk.progress",
      payload: { kind: "enrich", done: 1, total: 3, failed: 0, remaining: 2 },
    });
    expect(screen.getByText(/Completed 1 of 3.*Remaining 2/)).toBeInTheDocument();

    // Revoking consent makes the runner stop itself; no Cancel click happened.
    await emit(canceledBroadcast);

    expect(
      screen.getByText("Canceled. Processed 1 of 3 pages. 2 were not processed. 0 failed."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

it("disables semantic re-index when no pages are missing embeddings", async () => {
  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    loadStorageStats: vi
      .fn()
      .mockResolvedValue({ pageCount: 3, totalTextBytes: 100, pagesMissingEmbeddings: 0 }),
  });

  const button = await screen.findByRole("button", { name: /Re-index semantic search/ });
  expect(button).toBeDisabled();
});

it("exports data when export button is clicked", async () => {
  const exportData = vi.fn().mockResolvedValue(JSON.stringify({ schemaVersion: 1, pages: [] }));

  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    exportData,
  });

  const exportButton = await screen.findByRole("button", { name: /Export Data/ });
  expect(exportButton).toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(exportButton);

  expect(exportData).toHaveBeenCalledOnce();
});

it("shows delete-all button and confirmation dialog before deleting", async () => {
  const deleteAll = vi.fn().mockResolvedValue(undefined);

  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
    deleteAll,
  });

  const deleteButton = await screen.findByRole("button", { name: /Delete All Data/ });
  expect(deleteButton).toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(deleteButton);

  // confirmation dialog should appear
  expect(await screen.findByText(/Are you sure/i)).toBeInTheDocument();

  // clicking cancel should NOT call deleteAll
  const cancelButton = screen.getByRole("button", { name: /Cancel/i });
  await user.click(cancelButton);
  expect(deleteAll).not.toHaveBeenCalled();
});

it("calls deleteAll when user confirms deletion", async () => {
  const deleteAll = vi.fn().mockResolvedValue(undefined);

  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
    deleteAll,
  });

  const user = userEvent.setup();
  const deleteButton = await screen.findByRole("button", { name: /Delete All Data/ });
  await user.click(deleteButton);

  const confirmButton = await screen.findByRole("button", { name: /Confirm/i });
  await user.click(confirmButton);

  expect(deleteAll).toHaveBeenCalledOnce();
});

it("confirms semantic re-index and shows live progress", async () => {
  const { subscribe, emit } = makeSubscribe();
  const startReindexSemantic = vi.fn().mockResolvedValue({ total: 2 });
  const prepareReindexSemantic = vi.fn().mockResolvedValue({ batchId: "semantic-1", count: 2 });

  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    loadStorageStats: vi
      .fn()
      .mockResolvedValue({ pageCount: 2, totalTextBytes: 100, pagesMissingEmbeddings: 2 }),
    startReindexSemantic,
    prepareReindexSemantic,
    subscribe,
  });

  const user = userEvent.setup();
  const button = await screen.findByRole("button", { name: /Re-index semantic search \(2\)/ });
  await user.click(button);

  expect(startReindexSemantic).not.toHaveBeenCalled();
  expect(screen.getByText(/Re-index 2 pages\?/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Re-index semantic search" }));
  expect(startReindexSemantic).toHaveBeenCalledWith("semantic-1");
  await emit({
    type: "bulk.progress",
    payload: { kind: "semantic", done: 1, total: 2, failed: 0, remaining: 1 },
  });
  expect(await screen.findByText(/Completed 1 of 2.*Remaining 1/)).toBeInTheDocument();
});

// ── Error handling for data management actions ───────────────────────────────

it("shows an error message when exportData rejects", async () => {
  const exportData = vi.fn().mockRejectedValue(new Error("Worker unavailable"));

  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
    exportData,
  });

  const user = userEvent.setup();
  const exportButton = await screen.findByRole("button", { name: /Export Data/ });
  await user.click(exportButton);

  expect(await screen.findByText("Worker unavailable")).toBeInTheDocument();
});

it("shows an error message when deleteAll rejects", async () => {
  const deleteAll = vi.fn().mockRejectedValue(new Error("Transaction failed"));

  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
    deleteAll,
  });

  const user = userEvent.setup();
  const deleteButton = await screen.findByRole("button", { name: /Delete All Data/ });
  await user.click(deleteButton);

  const confirmButton = await screen.findByRole("button", { name: /Confirm/i });
  await user.click(confirmButton);

  expect(await screen.findByText("Transaction failed")).toBeInTheDocument();
  // Confirmation dialog remains open so the user can see the error
  expect(screen.getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
});

// ── Auto-save toggle ─────────────────────────────────────────────────────────

it("renders the auto-save toggle from the stored flag", async () => {
  renderOptions({
    loadAutoSave: async () => true,
    setAutoSave: async () => {},
  });

  const checkbox = await screen.findByRole("checkbox", { name: /enable auto-save/i });
  await waitFor(() => expect(checkbox).toBeChecked());
  expect(checkbox).toBeEnabled();
});

it("persists the flag when toggled", async () => {
  const setAutoSave = vi.fn().mockResolvedValue(undefined);
  const { user } = renderOptions({
    loadAutoSave: async () => false,
    setAutoSave,
  });

  const checkbox = await screen.findByRole("checkbox", { name: /enable auto-save/i });
  await user.click(checkbox);

  expect(setAutoSave).toHaveBeenCalledWith(true);
});

it("lists the allowlisted domains", async () => {
  renderOptions({
    loadAutoSave: async () => false,
    setAutoSave: async () => {},
  });

  expect(await screen.findByText("github.com")).toBeInTheDocument();
  expect(screen.getByText("stackoverflow.com")).toBeInTheDocument();
  expect(screen.getByText("*.readthedocs.io")).toBeInTheDocument();
});

// ── Status-text dark: variant assertions ─────────────────────────────────────

describe("Options status-text dark: variants", () => {
  it("the API-key warning uses the required copy and dark-mode class", async () => {
    renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
      loadStorageStats: vi
        .fn()
        .mockResolvedValue({ pageCount: 5, totalTextBytes: 1024, pagesMissingEmbeddings: 2 }),
    });

    const warning = (await screen.findAllByText("Add an API key to use AI features."))[0];
    expect(warning).toHaveClass("dark:text-amber-300");
  });

  it("connection-test success message carries dark:text-emerald-300", async () => {
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
      testConnection: vi
        .fn()
        .mockResolvedValue({ success: true, message: "Connection successful" }),
    });

    const testButton = await screen.findByRole("button", { name: "Test connection" });
    await user.click(testButton);

    const message = await screen.findByText("Connection successful");
    expect(message).toHaveClass("dark:text-emerald-300");
  });

  it("connection-test failure message carries dark:text-red-300", async () => {
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
      testConnection: vi.fn().mockResolvedValue({ success: false, message: "Invalid API key" }),
    });

    const testButton = await screen.findByRole("button", { name: "Test connection" });
    await user.click(testButton);

    const message = await screen.findByText("Invalid API key");
    expect(message).toHaveClass("dark:text-red-300");
  });

  it("'Delete All Data' button carries dark:text-red-300", async () => {
    renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
    });

    const deleteBtn = await screen.findByRole("button", { name: /Delete All Data/ });
    expect(deleteBtn).toHaveClass("dark:text-red-300");
  });

  it("delete confirmation text carries dark:text-red-200", async () => {
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
    });

    const deleteBtn = await screen.findByRole("button", { name: /Delete All Data/ });
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByText(/Are you sure/i)).toBeInTheDocument();
    });

    const confirmText = screen.getByText(/Are you sure you want to delete all saved pages/i);
    expect(confirmText).toHaveClass("dark:text-red-200");
  });
});
