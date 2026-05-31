import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkerBroadcast } from "../shared/messages";
import { Options } from "./Options";

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
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();

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
    expect(message).toHaveClass("text-green-600");
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
    expect(message).toHaveClass("text-red-600");
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
