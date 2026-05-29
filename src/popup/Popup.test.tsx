import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UrlStatus } from "./Popup";
import { Popup } from "./Popup";

// Helper to make a resolved loadUrlStatus mock
const makeUrlStatus = (status: UrlStatus) => vi.fn().mockResolvedValue(status);

describe("Popup", () => {
  it("disables save when no API key is set", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(false);
    render(<Popup saveCurrentPage={vi.fn()} checkApiKey={checkApiKey} />);

    expect(await screen.findByText("Set API key in settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save this page" })).toBeDisabled();
  });

  it("enables save when API key is set", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(true);
    render(<Popup saveCurrentPage={vi.fn()} checkApiKey={checkApiKey} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this page" })).toBeEnabled();
    });
    expect(screen.queryByText("Set API key in settings")).not.toBeInTheDocument();
  });

  it("saves the current page and shows a saved state", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockResolvedValue(undefined);
    const checkApiKey = vi.fn().mockResolvedValue(true);

    render(<Popup saveCurrentPage={saveCurrentPage} checkApiKey={checkApiKey} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this page" })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(saveCurrentPage).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Saved" })).toBeEnabled();
  });

  it("shows an error state when save fails", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockRejectedValue(new Error("no tab"));
    const checkApiKey = vi.fn().mockResolvedValue(true);

    render(<Popup saveCurrentPage={saveCurrentPage} checkApiKey={checkApiKey} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this page" })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(await screen.findByText("Failed to save page")).toBeInTheDocument();
  });

  it("opens the side panel through the injected callback", async () => {
    const user = userEvent.setup();
    const openSidePanel = vi.fn();
    const checkApiKey = vi.fn().mockResolvedValue(true);

    render(
      <Popup
        openSidePanel={openSidePanel}
        saveCurrentPage={vi.fn()}
        checkApiKey={checkApiKey}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open library" }));

    expect(openSidePanel).toHaveBeenCalledTimes(1);
  });

  // --- urlStatus behavior matrix tests ---

  it("shows 'Save this page' when loadUrlStatus returns saved: false (idle)", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(true);
    const loadUrlStatus = makeUrlStatus({ saved: false });

    render(
      <Popup
        saveCurrentPage={vi.fn()}
        checkApiKey={checkApiKey}
        loadUrlStatus={loadUrlStatus}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this page" })).toBeEnabled();
    });
    expect(loadUrlStatus).toHaveBeenCalledTimes(1);
  });

  it("shows 'Processing...' (disabled) when loadUrlStatus returns pending", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(true);
    const loadUrlStatus = makeUrlStatus({
      saved: true,
      status: "pending",
      savedAt: Date.now(),
    });

    render(
      <Popup
        saveCurrentPage={vi.fn()}
        checkApiKey={checkApiKey}
        loadUrlStatus={loadUrlStatus}
      />,
    );

    expect(await screen.findByRole("button", { name: "Processing..." })).toBeDisabled();
  });

  it("shows 'Saved ✓ ...' (disabled) when loadUrlStatus returns ready", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(true);
    const loadUrlStatus = makeUrlStatus({
      saved: true,
      status: "ready",
      savedAt: Date.now() - 30000,
    });

    render(
      <Popup
        saveCurrentPage={vi.fn()}
        checkApiKey={checkApiKey}
        loadUrlStatus={loadUrlStatus}
      />,
    );

    await waitFor(() => {
      const btn = screen.queryByRole("button", { name: /Saved ✓/ });
      expect(btn).toBeInTheDocument();
      expect(btn).toBeDisabled();
    });
  });

  it("shows 'Save failed — try again' (enabled) when loadUrlStatus returns failed", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(true);
    const loadUrlStatus = makeUrlStatus({
      saved: true,
      status: "failed",
      savedAt: Date.now(),
    });

    render(
      <Popup
        saveCurrentPage={vi.fn()}
        checkApiKey={checkApiKey}
        loadUrlStatus={loadUrlStatus}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Save failed — try again" }),
    ).toBeEnabled();
  });

  it("polls every 2s while status is pending", async () => {
    vi.useFakeTimers();
    try {
      const checkApiKey = vi.fn().mockResolvedValue(true);
      const loadUrlStatus = makeUrlStatus({
        saved: true,
        status: "pending",
        savedAt: Date.now(),
      });

      render(
        <Popup
          saveCurrentPage={vi.fn()}
          checkApiKey={checkApiKey}
          loadUrlStatus={loadUrlStatus}
        />,
      );

      // Initial mount call
      await act(async () => {
        await Promise.resolve();
      });
      expect(loadUrlStatus).toHaveBeenCalledTimes(1);

      // Advance 2 seconds → second call
      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });
      expect(loadUrlStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
