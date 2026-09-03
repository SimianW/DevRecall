import type { PageStatus } from "../shared/types";
import type { ManualSaveResult } from "../shared/messages";

export const SAVE_CURRENT_PAGE_COMMAND = "save-current-page";

export type CommandTab = {
  id?: number;
  url?: string;
};

export type ManualSaveCommandDeps = {
  getPageKey(url: string): Promise<string>;
  findPage(pageKey: string): Promise<{ status: PageStatus } | undefined>;
  save(tabId: number): Promise<void>;
  getTabUrl(tabId: number): Promise<string | null>;
  showPageResult(tabId: number, result: ManualSaveResult): Promise<boolean>;
  showFailureBadge(tabId: number): Promise<void>;
  reportError(error: unknown): void;
};

type ActionBadgePort = {
  setBadgeBackgroundColor(details: { color: string; tabId: number }): Promise<void>;
  setBadgeText(details: { text: string; tabId: number }): Promise<void>;
};

export function createFailureBadge(action: ActionBadgePort) {
  const clearTimers = new Map<number, ReturnType<typeof setTimeout>>();

  return async (tabId: number): Promise<void> => {
    const previousTimer = clearTimers.get(tabId);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    await action.setBadgeBackgroundColor({ color: "#dc2626", tabId });
    await action.setBadgeText({ text: "!", tabId });

    const timer = setTimeout(() => {
      clearTimers.delete(tabId);
      void action.setBadgeText({ text: "", tabId }).catch(() => {});
    }, 3_000);
    clearTimers.set(tabId, timer);
  };
}

export function createManualSaveCommandHandler(deps: ManualSaveCommandDeps) {
  const inFlightTabs = new Set<number>();
  const pageQueueTails = new Map<string, Promise<void>>();

  async function runForPage<T>(pageKey: string, action: () => Promise<T>): Promise<T> {
    const previous = pageQueueTails.get(pageKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    pageQueueTails.set(pageKey, tail);

    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (pageQueueTails.get(pageKey) === tail) {
        pageQueueTails.delete(pageKey);
      }
    }
  }

  return async (command: string, tab: CommandTab): Promise<void> => {
    if (command !== SAVE_CURRENT_PAGE_COMMAND || typeof tab.id !== "number" || !tab.url) {
      return;
    }
    if (inFlightTabs.has(tab.id)) {
      return;
    }

    const tabId = tab.id;
    const triggeringUrl = tab.url;
    inFlightTabs.add(tabId);
    try {
      let result: ManualSaveResult;
      try {
        const pageKey = await deps.getPageKey(triggeringUrl);
        result = await runForPage(pageKey, async () => {
          const page = await deps.findPage(pageKey);
          if (page && page.status !== "failed") {
            return "already_saved";
          }
          await deps.save(tabId);
          return "saved";
        });
      } catch (error) {
        deps.reportError(error);
        result = "failed";
      }

      if ((await deps.getTabUrl(tabId)) === triggeringUrl) {
        const displayed = await deps.showPageResult(tabId, result);
        if (!displayed && result === "failed") {
          await deps.showFailureBadge(tabId);
        }
      }
    } finally {
      inFlightTabs.delete(tabId);
    }
  };
}
