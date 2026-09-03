import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFailureBadge,
  createManualSaveCommandHandler,
  SAVE_CURRENT_PAGE_COMMAND,
} from "./manualSaveCommand";

afterEach(() => {
  vi.useRealTimers();
});

function makeDeps() {
  return {
    getPageKey: vi.fn().mockResolvedValue("page-key"),
    findPage: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    getTabUrl: vi.fn().mockResolvedValue("https://example.com/docs"),
    showPageResult: vi.fn().mockResolvedValue(true),
    showFailureBadge: vi.fn().mockResolvedValue(undefined),
    reportError: vi.fn(),
  };
}

describe("keyboard-triggered manual save", () => {
  it("saves the triggering tab and reports local success", async () => {
    const deps = makeDeps();
    const handleManualSave = createManualSaveCommandHandler(deps);

    await handleManualSave(SAVE_CURRENT_PAGE_COMMAND, {
      id: 42,
      url: "https://example.com/docs",
    });

    expect(deps.getPageKey).toHaveBeenCalledWith("https://example.com/docs");
    expect(deps.findPage).toHaveBeenCalledWith("page-key");
    expect(deps.save).toHaveBeenCalledWith(42);
    expect(deps.showPageResult).toHaveBeenCalledWith(42, "saved");
  });

  it("reports an existing saved page without saving or processing it again", async () => {
    const deps = makeDeps();
    deps.findPage.mockResolvedValue({ status: "ready" });
    const handleManualSave = createManualSaveCommandHandler(deps);

    await handleManualSave(SAVE_CURRENT_PAGE_COMMAND, {
      id: 42,
      url: "https://example.com/docs",
    });

    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.showPageResult).toHaveBeenCalledWith(42, "already_saved");
  });

  it("retries a previously failed saved page", async () => {
    const deps = makeDeps();
    deps.findPage.mockResolvedValue({ status: "failed" });
    const handleManualSave = createManualSaveCommandHandler(deps);

    await handleManualSave(SAVE_CURRENT_PAGE_COMMAND, {
      id: 42,
      url: "https://example.com/docs",
    });

    expect(deps.save).toHaveBeenCalledWith(42);
    expect(deps.showPageResult).toHaveBeenCalledWith(42, "saved");
  });

  it("runs only one manual save command at a time for the same tab", async () => {
    const deps = makeDeps();
    let finishSave: (() => void) | undefined;
    deps.save.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const handleManualSave = createManualSaveCommandHandler(deps);
    const tab = { id: 42, url: "https://example.com/docs" };

    const first = handleManualSave(SAVE_CURRENT_PAGE_COMMAND, tab);
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalledOnce());
    const second = handleManualSave(SAVE_CURRENT_PAGE_COMMAND, tab);

    expect(deps.save).toHaveBeenCalledOnce();
    finishSave?.();
    await Promise.all([first, second]);
    expect(deps.showPageResult).toHaveBeenCalledOnce();
  });

  it("falls back to a per-tab badge when failure feedback cannot reach the page", async () => {
    const deps = makeDeps();
    const failure = new Error("No readable page text found");
    deps.save.mockRejectedValue(failure);
    deps.showPageResult.mockResolvedValue(false);
    const handleManualSave = createManualSaveCommandHandler(deps);

    await handleManualSave(SAVE_CURRENT_PAGE_COMMAND, {
      id: 42,
      url: "https://example.com/docs",
    });

    expect(deps.reportError).toHaveBeenCalledWith(failure);
    expect(deps.showPageResult).toHaveBeenCalledWith(42, "failed");
    expect(deps.showFailureBadge).toHaveBeenCalledWith(42);
  });

  it("does not show a stale result after the triggering tab navigates", async () => {
    const deps = makeDeps();
    deps.getTabUrl.mockResolvedValue("https://example.com/another-page");
    const handleManualSave = createManualSaveCommandHandler(deps);

    await handleManualSave(SAVE_CURRENT_PAGE_COMMAND, {
      id: 42,
      url: "https://example.com/docs",
    });

    expect(deps.save).toHaveBeenCalledWith(42);
    expect(deps.showPageResult).not.toHaveBeenCalled();
    expect(deps.showFailureBadge).not.toHaveBeenCalled();
  });

  it("does not show a stale result after the triggering tab closes", async () => {
    const deps = makeDeps();
    deps.getTabUrl.mockResolvedValue(null);
    const handleManualSave = createManualSaveCommandHandler(deps);

    await handleManualSave(SAVE_CURRENT_PAGE_COMMAND, {
      id: 42,
      url: "https://example.com/docs",
    });

    expect(deps.save).toHaveBeenCalledWith(42);
    expect(deps.showPageResult).not.toHaveBeenCalled();
    expect(deps.showFailureBadge).not.toHaveBeenCalled();
  });

  it("allows different tabs to save concurrently", async () => {
    const deps = makeDeps();
    deps.getPageKey.mockImplementation(async (url: string) => url);
    const finishes: Array<() => void> = [];
    deps.save.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishes.push(resolve);
        }),
    );
    const handleManualSave = createManualSaveCommandHandler(deps);

    const first = handleManualSave(SAVE_CURRENT_PAGE_COMMAND, {
      id: 42,
      url: "https://example.com/docs",
    });
    const second = handleManualSave(SAVE_CURRENT_PAGE_COMMAND, {
      id: 43,
      url: "https://example.com/other-docs",
    });
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalledTimes(2));

    finishes.forEach((finish) => finish());
    await Promise.all([first, second]);
    expect(deps.save).toHaveBeenCalledWith(42);
    expect(deps.save).toHaveBeenCalledWith(43);
  });

  it("serializes the same page across tabs so only the first reports a new save", async () => {
    const deps = makeDeps();
    let finishFirstSave: (() => void) | undefined;
    deps.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstSave = resolve;
        }),
    );
    deps.findPage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: "keyword_ready" });
    const handleManualSave = createManualSaveCommandHandler(deps);
    const url = "https://example.com/docs";

    const first = handleManualSave(SAVE_CURRENT_PAGE_COMMAND, { id: 42, url });
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalledOnce());
    const second = handleManualSave(SAVE_CURRENT_PAGE_COMMAND, { id: 43, url });

    await Promise.resolve();
    expect(deps.findPage).toHaveBeenCalledOnce();
    finishFirstSave?.();
    await Promise.all([first, second]);
    expect(deps.save).toHaveBeenCalledOnce();
    expect(deps.showPageResult).toHaveBeenCalledWith(42, "saved");
    expect(deps.showPageResult).toHaveBeenCalledWith(43, "already_saved");
  });
});

describe("manual save failure badge", () => {
  it("shows a red per-tab exclamation and clears it after three seconds", async () => {
    vi.useFakeTimers();
    const action = {
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
    };
    const showFailureBadge = createFailureBadge(action);

    await showFailureBadge(42);

    expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#dc2626", tabId: 42 });
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "!", tabId: 42 });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: "", tabId: 42 });
  });
});
