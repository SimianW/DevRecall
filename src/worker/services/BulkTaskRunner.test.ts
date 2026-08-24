import { describe, expect, it, vi } from "vitest";

import { BulkTaskRunner, type BulkTaskProgress } from "./BulkTaskRunner";

describe("BulkTaskRunner", () => {
  it("runs pages sequentially and continues after a page failure", async () => {
    const runner = new BulkTaskRunner();
    const order: string[] = [];
    const progress: BulkTaskProgress[] = [];

    runner.begin({
      kind: "enrich",
      pageIds: ["a", "b", "c"],
      shouldContinue: async () => true,
      runPage: async (id) => {
        order.push(`start:${id}`);
        if (id === "b") throw new Error("bad page");
        order.push(`end:${id}`);
      },
      onProgress: (value) => progress.push(value),
    });

    await vi.waitFor(() => expect(runner.isRunning()).toBe(false));
    expect(order).toEqual(["start:a", "end:a", "start:b", "start:c", "end:c"]);
    expect(progress.at(-1)).toMatchObject({ done: 3, failed: 1, remaining: 0 });
  });

  it("lets the in-flight page finish and stops before the next page", async () => {
    const runner = new BulkTaskRunner();
    let release: (() => void) | undefined;
    const firstPage = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runPage = vi.fn(async () => firstPage);
    const progress: BulkTaskProgress[] = [];

    runner.begin({
      kind: "semantic",
      pageIds: ["a", "b"],
      shouldContinue: async () => true,
      runPage,
      onProgress: (value) => progress.push(value),
    });

    await vi.waitFor(() => expect(runPage).toHaveBeenCalledWith("a"));
    expect(runner.cancel()).toBe(true);
    expect(runner.isRunning()).toBe(true);
    expect(() =>
      runner.begin({
        kind: "enrich",
        pageIds: ["c"],
        shouldContinue: async () => true,
        runPage: async () => {},
        onProgress: () => {},
      }),
    ).toThrow("A bulk operation is already running");
    release?.();

    await vi.waitFor(() => expect(progress.some((entry) => entry.canceled)).toBe(true));
    expect(runPage).toHaveBeenCalledTimes(1);
    expect(progress.at(-1)).toMatchObject({ done: 1, remaining: 1, canceled: true });
    expect(progress.some((entry) => entry.currentPageId === "b")).toBe(false);
  });

  it("does not start a page when canceled during the permission check", async () => {
    const runner = new BulkTaskRunner();
    let releaseCheck: ((allowed: boolean) => void) | undefined;
    const permission = new Promise<boolean>((resolve) => {
      releaseCheck = resolve;
    });
    const runPage = vi.fn().mockResolvedValue(undefined);
    const progress: BulkTaskProgress[] = [];

    runner.begin({
      kind: "enrich",
      pageIds: ["a"],
      shouldContinue: async () => permission,
      runPage,
      onProgress: (value) => progress.push(value),
    });

    expect(runner.cancel()).toBe(true);
    releaseCheck?.(true);

    await vi.waitFor(() => expect(progress.some((entry) => entry.canceled)).toBe(true));
    expect(runPage).not.toHaveBeenCalled();
  });

  it("rechecks permission immediately before each queued page", async () => {
    const runner = new BulkTaskRunner();
    const runPage = vi.fn().mockResolvedValue(undefined);
    const shouldContinue = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const progress: BulkTaskProgress[] = [];

    runner.begin({
      kind: "enrich",
      pageIds: ["a", "b"],
      shouldContinue,
      runPage,
      onProgress: (value) => progress.push(value),
    });

    await vi.waitFor(() => expect(progress.some((entry) => entry.canceled)).toBe(true));
    expect(runPage).toHaveBeenCalledOnce();
    expect(runPage).toHaveBeenCalledWith("a");
  });
});
