import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UrlStatus } from "./Popup";
import { defaultSaveCurrentPage, Popup } from "./Popup";

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

    expect(
      await screen.findByText("Couldn't read this page — reload it and try again."),
    ).toBeInTheDocument();
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

  it("shows 'Saving...' (disabled) while a local save is in progress", async () => {
    const user = userEvent.setup();
    const checkApiKey = vi.fn().mockResolvedValue(true);
    const loadUrlStatus = makeUrlStatus({ saved: false });
    // saveCurrentPage never resolves — keeps the component in the saving state
    const saveCurrentPage = vi.fn().mockReturnValue(new Promise(() => {}));

    render(
      <Popup
        saveCurrentPage={saveCurrentPage}
        checkApiKey={checkApiKey}
        loadUrlStatus={loadUrlStatus}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this page" })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
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

  it("shows immediate feedback when retrying a failed save", async () => {
    const user = userEvent.setup();
    const checkApiKey = vi.fn().mockResolvedValue(true);
    const loadUrlStatus = makeUrlStatus({
      saved: true,
      status: "failed",
      savedAt: Date.now(),
    });
    // never-resolving save keeps the component in the saving state
    const saveCurrentPage = vi.fn().mockReturnValue(new Promise(() => {}));

    render(
      <Popup
        saveCurrentPage={saveCurrentPage}
        checkApiKey={checkApiKey}
        loadUrlStatus={loadUrlStatus}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Save failed — try again" }),
    );

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(saveCurrentPage).toHaveBeenCalledTimes(1);
  });

  it("transitions to saved after retrying without reopening", async () => {
    const user = userEvent.setup();
    const checkApiKey = vi.fn().mockResolvedValue(true);
    // first load: failed; after the retry re-fetch: ready
    const loadUrlStatus = vi
      .fn()
      .mockResolvedValueOnce({
        saved: true,
        status: "failed",
        savedAt: Date.now(),
      })
      .mockResolvedValue({
        saved: true,
        status: "ready",
        savedAt: Date.now(),
      });
    const saveCurrentPage = vi.fn().mockResolvedValue(undefined);

    render(
      <Popup
        saveCurrentPage={saveCurrentPage}
        checkApiKey={checkApiKey}
        loadUrlStatus={loadUrlStatus}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Save failed — try again" }),
    );

    expect(
      await screen.findByRole("button", { name: /Saved ✓/ }),
    ).toBeInTheDocument();
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

describe("defaultSaveCurrentPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws with the worker's message when the response is an error", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      type: "error",
      payload: {
        message: "Could not establish connection. Receiving end does not exist.",
      },
    });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1 }]) },
      runtime: { sendMessage },
    });

    await expect(defaultSaveCurrentPage()).rejects.toThrow(
      "Could not establish connection. Receiving end does not exist.",
    );
  });

  it("resolves when the worker responds normally", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      type: "page.saved",
      payload: { page: {} },
    });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1 }]) },
      runtime: { sendMessage },
    });

    await expect(defaultSaveCurrentPage()).resolves.toBeUndefined();
  });
});
