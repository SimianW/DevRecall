import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkerBroadcast } from "../shared/messages";
import { SaveBar } from "./SaveBar";

const tab = {
  tabId: 7,
  title: "Using chrome.alarms",
  url: "https://developer.chrome.com/docs/extensions/reference/api/alarms",
};

function makeProps(overrides: Partial<Parameters<typeof SaveBar>[0]> = {}) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(tab),
    saveTab: vi.fn().mockResolvedValue(undefined),
    loadUrlStatus: vi.fn().mockResolvedValue({ saved: false }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onTabChange: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

describe("SaveBar", () => {
  it("renders nothing when there is no active tab", async () => {
    const props = makeProps({ getActiveTab: vi.fn().mockResolvedValue(null) });
    const { container } = render(<SaveBar {...props} />);

    await waitFor(() => expect(props.getActiveTab).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the active tab title and domain with a save button", async () => {
    render(<SaveBar {...makeProps()} />);

    expect(await screen.findByText("Using chrome.alarms")).toBeInTheDocument();
    expect(screen.getByText("developer.chrome.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save to library/i })).toBeEnabled();
  });

  it("saves the active tab on click and shows Saving…", async () => {
    let resolveSave!: () => void;
    const saveTab = vi.fn().mockReturnValue(new Promise<void>((r) => (resolveSave = r)));
    const user = userEvent.setup();
    render(<SaveBar {...makeProps({ saveTab })} />);

    await user.click(await screen.findByRole("button", { name: /save to library/i }));

    expect(saveTab).toHaveBeenCalledWith(7);
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
    resolveSave();
  });

  it("shows Processing… while the saved page is pending", async () => {
    const loadUrlStatus = vi
      .fn()
      .mockResolvedValue({ saved: true, status: "pending", savedAt: Date.now() });
    render(<SaveBar {...makeProps({ loadUrlStatus })} />);

    expect(await screen.findByRole("button", { name: /processing/i })).toBeDisabled();
  });

  it("shows keyword-ready pages as saved locally and prevents another save", async () => {
    const saveTab = vi.fn().mockResolvedValue(undefined);
    const loadUrlStatus = vi.fn().mockResolvedValue({
      saved: true,
      status: "keyword_ready",
      savedAt: Date.now() - 120_000,
    });
    render(<SaveBar {...makeProps({ loadUrlStatus, saveTab })} />);

    const button = await screen.findByRole("button", { name: /saved locally.*2m ago/i });
    expect(button).toBeDisabled();
    expect(saveTab).not.toHaveBeenCalled();
  });

  it("shows enriching pages as adding AI features and prevents another save", async () => {
    const saveTab = vi.fn().mockResolvedValue(undefined);
    const loadUrlStatus = vi.fn().mockResolvedValue({
      saved: true,
      status: "enriching",
      savedAt: Date.now(),
    });
    render(<SaveBar {...makeProps({ loadUrlStatus, saveTab })} />);

    const button = await screen.findByRole("button", { name: "Adding AI features…" });
    expect(button).toBeDisabled();
    expect(saveTab).not.toHaveBeenCalled();
  });

  it("shows Saved with relative time when ready", async () => {
    const loadUrlStatus = vi
      .fn()
      .mockResolvedValue({ saved: true, status: "ready", savedAt: Date.now() - 120_000 });
    render(<SaveBar {...makeProps({ loadUrlStatus })} />);

    expect(await screen.findByRole("button", { name: /saved ✓ 2m ago/i })).toBeDisabled();
  });

  it("offers retry when the save failed", async () => {
    const loadUrlStatus = vi
      .fn()
      .mockResolvedValue({ saved: true, status: "failed", savedAt: Date.now() });
    render(<SaveBar {...makeProps({ loadUrlStatus })} />);

    expect(await screen.findByRole("button", { name: /save failed — try again/i })).toBeEnabled();
  });

  it("re-resolves the active tab when the tab changes", async () => {
    let fireTabChange!: () => void;
    const onTabChange = vi.fn().mockImplementation((handler: () => void) => {
      fireTabChange = handler;
      return () => {};
    });
    const getActiveTab = vi.fn().mockResolvedValue(tab);
    render(<SaveBar {...makeProps({ getActiveTab, onTabChange })} />);

    await screen.findByText("Using chrome.alarms");
    fireTabChange();

    await waitFor(() => expect(getActiveTab).toHaveBeenCalledTimes(2));
  });

  it("ignores a stale refresh that resolves after a newer one", async () => {
    const oldTab = { tabId: 1, title: "Old page", url: "https://github.com/old" };
    let resolveFirst!: (value: typeof tab | null) => void;
    const getActiveTab = vi
      .fn()
      // First call (mount): hangs until we resolve it manually — with the OLD tab.
      .mockImplementationOnce(() => new Promise<typeof tab | null>((r) => (resolveFirst = r)))
      // Second call (tab change): resolves immediately with the NEW tab.
      .mockResolvedValue(tab);

    let fireTabChange!: () => void;
    const onTabChange = vi.fn().mockImplementation((handler: () => void) => {
      fireTabChange = handler;
      return () => {};
    });

    render(<SaveBar {...makeProps({ getActiveTab, onTabChange })} />);

    // Trigger the newer refresh and let it complete.
    fireTabChange();
    expect(await screen.findByText("Using chrome.alarms")).toBeInTheDocument();

    // Now the stale first call resolves — it must NOT clobber the newer state.
    resolveFirst(oldTab);
    await waitFor(() => expect(getActiveTab).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Using chrome.alarms")).toBeInTheDocument();
    expect(screen.queryByText("Old page")).not.toBeInTheDocument();
  });

  it("shows a retry action when the active-tab query fails", async () => {
    const getActiveTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("tabs unavailable"))
      .mockResolvedValue(tab);
    render(<SaveBar {...makeProps({ getActiveTab })} />);

    expect(await screen.findByText("Could not refresh this page.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("tabs unavailable");

    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Using chrome.alarms")).toBeInTheDocument();
    expect(getActiveTab).toHaveBeenCalledTimes(2);
  });

  it("refreshes status for page removal and library changes", async () => {
    let broadcast!: (message: WorkerBroadcast) => void;
    const subscribe = vi.fn().mockImplementation((handler) => {
      broadcast = handler;
      return () => {};
    });
    const loadUrlStatus = vi.fn().mockResolvedValue({ saved: false });
    render(<SaveBar {...makeProps({ subscribe, loadUrlStatus })} />);
    await screen.findByText("Using chrome.alarms");

    broadcast({ type: "page.removed", payload: { id: "page-1" } });
    await waitFor(() => expect(loadUrlStatus).toHaveBeenCalledTimes(2));
    broadcast({ type: "library.changed" });
    await waitFor(() => expect(loadUrlStatus).toHaveBeenCalledTimes(3));
  });

  it("does not let a stale save failure affect a newly active tab", async () => {
    const newTab = { tabId: 8, title: "New page", url: "https://github.com/new" };
    let rejectSave!: (error: Error) => void;
    const saveTab = vi.fn().mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    const getActiveTab = vi.fn().mockResolvedValueOnce(tab).mockResolvedValueOnce(newTab);
    let fireTabChange!: () => void;
    const onTabChange = vi.fn().mockImplementation((handler: () => void) => {
      fireTabChange = handler;
      return () => {};
    });
    render(<SaveBar {...makeProps({ getActiveTab, saveTab, onTabChange })} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: /save to library/i }));
    fireTabChange();
    expect(await screen.findByText("New page")).toBeInTheDocument();
    rejectSave(new Error("old save failed"));

    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("Save to library"));
    expect(screen.queryByText("old save failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save failed/i })).not.toBeInTheDocument();
  });

  it("disables saving on restricted browser URLs with an explanation", async () => {
    const restrictedTab = {
      tabId: 7,
      title: "Extensions",
      url: "chrome://extensions",
    };
    const loadUrlStatus = vi.fn().mockResolvedValue({ saved: false });
    render(
      <SaveBar
        {...makeProps({ getActiveTab: vi.fn().mockResolvedValue(restrictedTab), loadUrlStatus })}
      />,
    );

    expect(await screen.findByText("Extensions")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Only HTTP and HTTPS pages can be saved.");
    expect(screen.getByRole("button", { name: "Save unavailable" })).toBeDisabled();
    expect(loadUrlStatus).not.toHaveBeenCalled();
  });

  it("shows the worker save error while offering a retry", async () => {
    const saveTab = vi.fn().mockRejectedValue(new Error("capture failed: no content"));
    render(<SaveBar {...makeProps({ saveTab })} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: /save to library/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("capture failed: no content");
    expect(screen.getByRole("button", { name: /save failed.*try again/i })).toBeEnabled();
  });
});
