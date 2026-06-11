import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkerBroadcast } from "../shared/messages";
import { Options } from "./Options";

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
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
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

it("disables re-index when no pages are missing embeddings", async () => {
  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    loadStorageStats: vi
      .fn()
      .mockResolvedValue({ pageCount: 3, totalTextBytes: 100, pagesMissingEmbeddings: 0 }),
  });

  const button = await screen.findByRole("button", { name: /Re-index library/ });
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

it("starts a re-index and shows live progress", async () => {
  const { subscribe, emit } = makeSubscribe();
  const startReindex = vi.fn().mockResolvedValue({ total: 2 });

  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    loadStorageStats: vi
      .fn()
      .mockResolvedValue({ pageCount: 2, totalTextBytes: 100, pagesMissingEmbeddings: 2 }),
    startReindex,
    subscribe,
  });

  const user = userEvent.setup();
  const button = await screen.findByRole("button", { name: /Re-index library \(2\)/ });
  await user.click(button);

  expect(startReindex).toHaveBeenCalled();
  await emit({ type: "library.reindexProgress", payload: { done: 1, total: 2 } });
  expect(await screen.findByText(/Re-indexing 1\s*\/\s*2/)).toBeInTheDocument();
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
  renderOptions({
    loadAutoSave: async () => false,
    setAutoSave,
  });

  const checkbox = await screen.findByRole("checkbox", { name: /enable auto-save/i });
  await userEvent.click(checkbox);

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
  it("'Set an API key to re-index' warning carries dark:text-amber-300", async () => {
    renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
      loadStorageStats: vi
        .fn()
        .mockResolvedValue({ pageCount: 5, totalTextBytes: 1024, pagesMissingEmbeddings: 2 }),
    });

    const warning = await screen.findByText("Set an API key to re-index.");
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
      testConnection: vi
        .fn()
        .mockResolvedValue({ success: false, message: "Invalid API key" }),
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
