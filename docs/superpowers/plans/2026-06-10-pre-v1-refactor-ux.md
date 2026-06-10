# Pre-v1.0 Refactor + UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-06-10-pre-v1-refactor-ux-design.md` — shared UI RPC client, worker handlers/entry split, auto-save toggle (off by default), popup removal (icon opens side panel, save moves into the panel), readable filter labels, and the Warm Editorial restyle.

**Architecture:** UI surfaces keep their dependency-injection props but their defaults collapse onto one typed RPC client. The worker splits into a pure `handlers.ts` (dispatcher, fully unit-testable) and a thin `index.ts` MV3 entry (composition + top-level Chrome listeners). Auto-save is gated by an `autoSaveEnabled` flag in `chrome.storage.local` (default off). The restyle is token-level via the existing CSS variables.

**Tech Stack:** React 18, TypeScript (strict), Vite + CRX, Vitest (jsdom, fake-indexeddb), Tailwind (CSS-variable tokens, `darkMode: "media"`), Chrome MV3.

**Branch:** `worktree-M6-polish-auto-save-ship` (work in the existing worktree at `.claude/worktrees/M6-polish-auto-save-ship`).

**Project rules that apply to every task:**
- TDD: write the failing test first, watch it fail, implement, watch it pass.
- **Version bump on every code-change commit**: bump `version` in `package.json` AND `APP_VERSION` in `src/shared/messages.ts` (they must match). This plan starts at `0.5.7.0` (Task 1) and bumps the last digit each task (exact version given per task).
- Run `pnpm typecheck && pnpm lint` before each commit.

---

### Task 1: Shared typed RPC client (`src/ui/rpc.ts`)

**Files:**
- Create: `src/ui/rpc.ts`
- Create: `src/ui/rpc.test.ts`
- Modify: `src/sidepanel/App.tsx` (default fns only)
- Modify: `src/options/Options.tsx` (default fns only)
- Modify: `package.json`, `src/shared/messages.ts` (version → `0.5.7.0`)

Do NOT touch `src/popup/` — it is deleted in Task 5.

- [ ] **Step 1: Write the failing tests**

Create `src/ui/rpc.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRequest, subscribeToBroadcasts } from "./rpc";

type ChromeStub = {
  runtime?: {
    sendMessage?: (message: unknown) => Promise<unknown>;
    onMessage?: {
      addListener: (listener: (message: unknown) => void) => void;
      removeListener: (listener: (message: unknown) => void) => void;
    };
  };
};

function installChrome(stub: ChromeStub) {
  (globalThis as { chrome?: ChromeStub }).chrome = stub;
}

afterEach(() => {
  delete (globalThis as { chrome?: ChromeStub }).chrome;
});

describe("sendRequest", () => {
  it("returns null when chrome.runtime is unavailable", async () => {
    const result = await sendRequest({ type: "devrecall.ping" }, "devrecall.pong");
    expect(result).toBeNull();
  });

  it("returns the typed response when the type matches", async () => {
    const response = {
      type: "page.listed",
      payload: { pages: [] },
    };
    const sendMessage = vi.fn().mockResolvedValue(response);
    installChrome({ runtime: { sendMessage } });

    const result = await sendRequest(
      { type: "page.list", payload: { limit: 50 } },
      "page.listed",
    );

    expect(sendMessage).toHaveBeenCalledWith({ type: "page.list", payload: { limit: 50 } });
    expect(result).toEqual(response);
  });

  it("returns null when the response type does not match", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ type: "error", payload: { message: "boom" } });
    installChrome({ runtime: { sendMessage } });

    const result = await sendRequest(
      { type: "page.list", payload: { limit: 50 } },
      "page.listed",
    );

    expect(result).toBeNull();
  });

  it("returns null when sendMessage rejects", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("no receiver"));
    installChrome({ runtime: { sendMessage } });

    const result = await sendRequest({ type: "devrecall.ping" }, "devrecall.pong");

    expect(result).toBeNull();
  });
});

describe("subscribeToBroadcasts", () => {
  it("returns a noop unsubscribe when chrome.runtime is unavailable", () => {
    const unsubscribe = subscribeToBroadcasts(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it("registers a listener and removes it on unsubscribe", () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    installChrome({ runtime: { onMessage: { addListener, removeListener } } });

    const handler = vi.fn();
    const unsubscribe = subscribeToBroadcasts(handler);

    expect(addListener).toHaveBeenCalledTimes(1);
    const registered = addListener.mock.calls[0][0];

    registered({ type: "library.cleared" });
    expect(handler).toHaveBeenCalledWith({ type: "library.cleared" });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(registered);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/ui/rpc.test.ts`
Expected: FAIL — cannot resolve `./rpc`.

- [ ] **Step 3: Implement `src/ui/rpc.ts`**

```typescript
import type {
  DevRecallRequest,
  DevRecallResponse,
  WorkerBroadcast,
} from "../shared/messages";

/**
 * Send a typed request to the worker. Returns the full typed response when the
 * worker answers with `expectedType`, otherwise null (chrome unavailable,
 * worker returned an error/mismatched type, or the channel rejected).
 * Fail-soft on purpose: UI callers decide their own fallbacks.
 */
export async function sendRequest<T extends DevRecallResponse["type"]>(
  request: DevRecallRequest,
  expectedType: T,
): Promise<Extract<DevRecallResponse, { type: T }> | null> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }

  try {
    const response = (await chrome.runtime.sendMessage(request)) as
      | DevRecallResponse
      | undefined;

    if (!response || response.type !== expectedType) {
      return null;
    }

    return response as Extract<DevRecallResponse, { type: T }>;
  } catch {
    return null;
  }
}

/** Subscribe to worker broadcasts. Returns an unsubscribe function. */
export function subscribeToBroadcasts(
  handler: (message: WorkerBroadcast) => void,
): () => void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
    return () => {};
  }

  const listener = (message: unknown) => {
    handler(message as WorkerBroadcast);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/ui/rpc.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Collapse `src/sidepanel/App.tsx` defaults onto the client**

Replace the four `default*` functions and `defaultSubscribe` (lines ~24–90) with:

```typescript
import { sendRequest, subscribeToBroadcasts } from "../ui/rpc";

async function defaultListPages(): Promise<PageListItem[]> {
  const response = await sendRequest(
    { type: "page.list", payload: { limit: 50 } },
    "page.listed",
  );
  return response?.payload.pages ?? [];
}

async function defaultRunSearch(query: string): Promise<PageHit[]> {
  const response = await sendRequest(
    { type: "search.run", payload: { query } },
    "search.results",
  );
  return response?.payload.hits ?? [];
}

async function defaultDeletePage(id: string): Promise<void> {
  await sendRequest({ type: "page.delete", payload: { id } }, "page.deleted");
}

async function defaultRetryPage(id: string): Promise<void> {
  await sendRequest({ type: "page.retry", payload: { id } }, "page.retryStarted");
}

const defaultSubscribe = subscribeToBroadcasts;
```

Remove the now-unused `DevRecallRequest`/`DevRecallResponse` imports from App.tsx (keep `WorkerBroadcast`).

- [ ] **Step 6: Collapse `src/options/Options.tsx` defaults onto the client**

Replace the seven `default*` constants (lines ~20–66) with:

```typescript
import { sendRequest, subscribeToBroadcasts } from "../ui/rpc";

const defaultLoadStatus = async (): Promise<StatusResult> => {
  const response = await sendRequest({ type: "settings.getStatus" }, "settings.status");
  return response?.payload ?? { hasApiKey: false };
};

const defaultSaveApiKey = async (apiKey: string): Promise<void> => {
  await sendRequest(
    { type: "settings.setApiKey", payload: { apiKey } },
    "settings.apiKeySet",
  );
};

const defaultTestConnection = async (): Promise<TestResult> => {
  const response = await sendRequest(
    { type: "settings.testConnection" },
    "settings.connectionTestResult",
  );
  return response?.payload ?? { success: false, message: "Connection test unavailable" };
};

const defaultLoadStorageStats = async (): Promise<StorageStats> => {
  const response = await sendRequest({ type: "storage.getStats" }, "storage.stats");
  if (!response) {
    throw new Error("Storage stats unavailable");
  }
  return response.payload;
};

const defaultStartReindex = async (): Promise<{ total: number }> => {
  const response = await sendRequest({ type: "library.reindex" }, "library.reindexStarted");
  return response?.payload ?? { total: 0 };
};

const defaultSubscribe = subscribeToBroadcasts;

const defaultExportData = async (): Promise<string> => {
  const response = await sendRequest({ type: "data.export" }, "data.exported");
  return response?.payload.json ?? "{}";
};

const defaultDeleteAll = async (): Promise<void> => {
  await sendRequest({ type: "data.deleteAll" }, "data.deletedAll");
};
```

Remove the now-unused `DevRecallRequest`/`DevRecallResponse` imports (keep `WorkerBroadcast`).

- [ ] **Step 7: Run the full suite, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green — the surfaces' injected-props tests don't exercise defaults, so nothing changes behaviorally.

- [ ] **Step 8: Bump version and commit**

Set `package.json` `version` to `0.5.7.0` and `APP_VERSION` in `src/shared/messages.ts` to `0.5.7.0`.

```bash
git add src/ui/rpc.ts src/ui/rpc.test.ts src/sidepanel/App.tsx src/options/Options.tsx package.json src/shared/messages.ts
git commit -m "refactor: shared typed RPC client for UI surfaces"
```

---

### Task 2: Split the worker — `handlers.ts` + thin entry + `processPageInBackground`

**Files:**
- Create: `src/worker/handlers.ts`
- Modify: `src/worker/index.ts` (shrinks to composition + listeners)
- Modify: `src/worker/index.test.ts` → rename to `src/worker/handlers.test.ts`
- Modify: `vitest.config.ts` (coverage include)
- Modify: `package.json`, `src/shared/messages.ts` (version → `0.5.7.1`)

- [ ] **Step 1: Create `src/worker/handlers.ts`**

Move from `index.ts` — unchanged except where noted: the `CapturePort`, `PageListPort`, `SearchPort` type aliases, `HandlerDeps`, `handleRequest`, and `handleMessage`. Changes:

1. `handleRequest` and `handleMessage` lose their `deps = defaultDeps` default — `deps` becomes a required parameter (composition lives in `index.ts`).
2. Add the shared background-processing helper and use it in `page.save` and `page.retry`.

The new file's imports and the helper:

```typescript
import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
  type WorkerBroadcast,
} from "../shared/messages";
import type { PageHit, PageListItem, PageRecord } from "../shared/types";
import { normalizeUrl } from "../lib/urlNormalize";
import { toPageListItem } from "./repository/PageRepo";
import type { ApiKeyStore } from "./settings/ApiKeyStore";

// ... CapturePort / PageListPort / SearchPort / HandlerDeps moved here verbatim ...

/**
 * Fire-and-forget LLM processing for a captured page: looks up the API key,
 * runs processPage, then invalidates the retrieval cache and broadcasts the
 * updated record. No-op when no API key is set. Errors are logged, never thrown.
 */
export function processPageInBackground(deps: HandlerDeps, pageId: string): void {
  void (async () => {
    const apiKey = await deps.apiKeyStore.getApiKey();
    if (!apiKey) {
      return;
    }
    const processed = await deps.captureService.processPage(pageId, apiKey);
    deps.retrievalService.invalidate();
    deps.broadcast({ type: "page.updated", payload: { page: toPageListItem(processed) } });
  })().catch((error) => {
    console.error("[DevRecall] background processing error:", error);
  });
}
```

`page.save` case becomes:

```typescript
    case "page.save": {
      const page = await deps.captureService.save(request.payload.tabId);
      const listItem = toPageListItem(page);

      deps.retrievalService.invalidate();
      deps.broadcast({ type: "page.updated", payload: { page: listItem } });

      processPageInBackground(deps, page.id);

      return { type: "page.saved", payload: { page: listItem } };
    }
```

`page.retry` keeps its guards (not-found / not-failed / no-API-key error responses) and its `updatePage` + immediate broadcast, but its trailing `void deps.captureService.processPage(...)` block is replaced by:

```typescript
      processPageInBackground(deps, page.id);

      return { type: "page.retryStarted", payload: { page: listItem } };
```

All other cases move verbatim. `handleMessage` moves verbatim (with required `deps`).

- [ ] **Step 2: Rewrite `src/worker/index.ts` as the thin MV3 entry**

Keep ONLY: the `broadcast` function, service construction (`pageRepo`, `chunkRepo`, `openai`, `captureService`, `defaultDeps`), the `autoSaveService` wiring, and all top-level `chrome.*` listener registrations. The `saveAuto` callback now reuses the helper:

```typescript
import { handleMessage, processPageInBackground, type HandlerDeps } from "./handlers";
// ...existing service imports stay...

const autoSaveService = new AutoSaveService(
  chromeAlarmPort,
  chromeSessionPort,
  chromeTabPort,
  {
    saveAuto: async (tabId: number) => {
      const page = await captureService.save(tabId, "auto");
      defaultDeps.retrievalService.invalidate();
      broadcast({ type: "page.updated", payload: { page: toPageListItem(page) } });
      processPageInBackground(defaultDeps, page.id);
      return page;
    },
  },
  {
    getByUrlHash: (urlHash: string) => pageRepo.getByUrlHash(urlHash),
  },
);
```

The onMessage registration passes deps explicitly:

```typescript
chrome.runtime.onMessage.addListener(
  (request: DevRecallRequest, _sender, sendResponse: (response: DevRecallResponse) => void) => {
    void handleMessage(request, sendResponse, defaultDeps);
    return true;
  },
);
```

Everything else (onInstalled, commands, alarms/tabs listeners with their `typeof chrome` guards and MV3 comments) stays as-is. Remove imports that moved to `handlers.ts` (`normalizeUrl`, `APP_NAME`, etc.).

- [ ] **Step 3: Move the test file**

```bash
git mv src/worker/index.test.ts src/worker/handlers.test.ts
```

In `handlers.test.ts` change line 6:

```typescript
import { handleMessage, handleRequest } from "./handlers";
```

- [ ] **Step 4: Add `handlers.ts` to coverage**

In `vitest.config.ts`, add to `coverage.include`:

```typescript
      include: [
        "src/lib/**/*.ts",
        "src/worker/handlers.ts",
        "src/worker/services/**/*.ts",
        "src/worker/llm/**/*.ts",
        "src/worker/settings/**/*.ts",
      ],
```

- [ ] **Step 5: Run the suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green. The `page.save` tests that assert "no processPage without API key" still pass — `processPageInBackground` checks the key itself. If a test awaited the background `processPage` via the old inline promise, it may need a `await vi.waitFor(...)`/flush — fix only if a test actually fails, and prefer `await Promise.resolve()` micro-task flushes.

- [ ] **Step 6: Bump version and commit**

Version → `0.5.7.1` in both files.

```bash
git add src/worker/handlers.ts src/worker/index.ts src/worker/handlers.test.ts vitest.config.ts package.json src/shared/messages.ts
git commit -m "refactor: split worker into handlers + thin MV3 entry, dedupe background processing"
```

---

### Task 3: Auto-save enabled flag (storage, messages, handler, service gate)

**Files:**
- Create: `src/shared/allowlist.ts` (moved from AutoSaveService, + display list)
- Create: `src/worker/settings/AutoSaveSettingStore.ts`
- Create: `src/worker/settings/AutoSaveSettingStore.test.ts`
- Modify: `src/shared/messages.ts` (new request/response types + version)
- Modify: `src/worker/handlers.ts` (deps + two cases)
- Modify: `src/worker/handlers.test.ts` (deps factory + new cases)
- Modify: `src/worker/services/AutoSaveService.ts` (enabled gate, allowlist import)
- Modify: `src/worker/services/AutoSaveService.test.ts` (stub port + new tests)
- Modify: `src/worker/index.ts` (wiring)
- Modify: `package.json` (version → `0.5.7.2`)

- [ ] **Step 1: Move the allowlist to `src/shared/allowlist.ts`**

The Options UI must render the allowlist (Task 4) without importing from `worker/services`. Create:

```typescript
/**
 * v1.0 auto-save allowlist of technical/documentation domains.
 * A URL must match at least one pattern before a dwell timer is started.
 */
export const ALLOWLIST_PATTERNS: RegExp[] = [
  /^https?:\/\/(www\.)?github\.com/,
  /^https?:\/\/(www\.)?stackoverflow\.com/,
  /^https?:\/\/(www\.)?developer\.mozilla\.org/,
  /^https?:\/\/docs\./,
  /^https?:\/\/.*\.readthedocs\.io/,
  /^https?:\/\/(www\.)?npmjs\.com/,
  /^https?:\/\/(www\.)?rust-lang\.org/,
  /^https?:\/\/(www\.)?python\.org/,
];

/** Human-readable allowlist, rendered in Options. Keep in sync with the patterns. */
export const ALLOWLIST_DISPLAY: string[] = [
  "github.com",
  "stackoverflow.com",
  "developer.mozilla.org",
  "docs.* (any docs. subdomain)",
  "*.readthedocs.io",
  "npmjs.com",
  "rust-lang.org",
  "python.org",
];

export function isAllowlisted(url: string): boolean {
  return ALLOWLIST_PATTERNS.some((pattern) => pattern.test(url));
}
```

In `src/worker/services/AutoSaveService.ts`, delete the local `ALLOWLIST_PATTERNS`/`isAllowlisted` definitions and replace with:

```typescript
import { isAllowlisted } from "../../shared/allowlist";

export { ALLOWLIST_PATTERNS, isAllowlisted } from "../../shared/allowlist";
```

(The re-export keeps existing test imports working.)

- [ ] **Step 2: Write failing tests for the setting store**

Create `src/worker/settings/AutoSaveSettingStore.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChromeAutoSaveSettingStore } from "./AutoSaveSettingStore";

type ChromeStub = {
  storage?: {
    local?: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
};

function installChrome(stub: ChromeStub) {
  (globalThis as { chrome?: ChromeStub }).chrome = stub;
}

afterEach(() => {
  delete (globalThis as { chrome?: ChromeStub }).chrome;
});

describe("ChromeAutoSaveSettingStore", () => {
  it("defaults to disabled when chrome.storage is unavailable", async () => {
    const store = new ChromeAutoSaveSettingStore();
    await expect(store.isEnabled()).resolves.toBe(false);
  });

  it("defaults to disabled when no value is stored", async () => {
    installChrome({
      storage: { local: { get: async () => ({}), set: async () => {} } },
    });
    const store = new ChromeAutoSaveSettingStore();
    await expect(store.isEnabled()).resolves.toBe(false);
  });

  it("returns true only for a stored true", async () => {
    installChrome({
      storage: {
        local: { get: async () => ({ autosave_enabled: true }), set: async () => {} },
      },
    });
    const store = new ChromeAutoSaveSettingStore();
    await expect(store.isEnabled()).resolves.toBe(true);
  });

  it("persists the flag via setEnabled", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    installChrome({ storage: { local: { get: async () => ({}), set } } });
    const store = new ChromeAutoSaveSettingStore();

    await store.setEnabled(true);

    expect(set).toHaveBeenCalledWith({ autosave_enabled: true });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test src/worker/settings/AutoSaveSettingStore.test.ts`
Expected: FAIL — cannot resolve `./AutoSaveSettingStore`.

- [ ] **Step 4: Implement `src/worker/settings/AutoSaveSettingStore.ts`**

```typescript
export type AutoSaveSettingStore = {
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
};

const STORAGE_KEY = "autosave_enabled";

/**
 * Auto-save opt-in flag in chrome.storage.local. Defaults to false (off):
 * silently capturing browsing history must be an explicit user choice.
 * Read failures also resolve to false — the safe direction.
 */
export class ChromeAutoSaveSettingStore implements AutoSaveSettingStore {
  async isEnabled(): Promise<boolean> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return false;
    }

    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] === true;
    } catch {
      return false;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      throw new Error("Chrome storage is unavailable");
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  }
}
```

Run: `pnpm test src/worker/settings/AutoSaveSettingStore.test.ts` — expected PASS.

- [ ] **Step 5: Add the messages**

In `src/shared/messages.ts` add to `DevRecallRequest`:

```typescript
  | { type: "settings.getAutoSave" }
  | { type: "settings.setAutoSave"; payload: { enabled: boolean } }
```

and to `DevRecallResponse`:

```typescript
  | { type: "settings.autoSave"; payload: { enabled: boolean } }
  | { type: "settings.autoSaveSet"; payload: { enabled: boolean } }
```

- [ ] **Step 6: Write failing handler tests**

In `src/worker/handlers.test.ts`, the deps factory (`makeDeps()`) gains an `autoSaveSettings` member — add to the object it returns:

```typescript
      autoSaveSettings: {
        isEnabled: vi.fn().mockResolvedValue(false),
        setEnabled: vi.fn().mockResolvedValue(undefined),
      },
```

Add tests:

```typescript
  it("settings.getAutoSave returns the stored flag", async () => {
    const deps = makeDeps();
    deps.autoSaveSettings.isEnabled = vi.fn().mockResolvedValue(true);

    await expect(handleRequest({ type: "settings.getAutoSave" }, deps)).resolves.toEqual({
      type: "settings.autoSave",
      payload: { enabled: true },
    });
  });

  it("settings.setAutoSave persists and echoes the flag", async () => {
    const deps = makeDeps();

    await expect(
      handleRequest({ type: "settings.setAutoSave", payload: { enabled: true } }, deps),
    ).resolves.toEqual({
      type: "settings.autoSaveSet",
      payload: { enabled: true },
    });
    expect(deps.autoSaveSettings.setEnabled).toHaveBeenCalledWith(true);
  });
```

Run: `pnpm test src/worker/handlers.test.ts` — expected FAIL (type error / unhandled request type).

- [ ] **Step 7: Implement handler support**

In `src/worker/handlers.ts`:

```typescript
import type { AutoSaveSettingStore } from "./settings/AutoSaveSettingStore";

// in HandlerDeps:
  autoSaveSettings: AutoSaveSettingStore;

// new cases in handleRequest:
    case "settings.getAutoSave":
      return {
        type: "settings.autoSave",
        payload: { enabled: await deps.autoSaveSettings.isEnabled() },
      };

    case "settings.setAutoSave": {
      await deps.autoSaveSettings.setEnabled(request.payload.enabled);
      return {
        type: "settings.autoSaveSet",
        payload: { enabled: request.payload.enabled },
      };
    }
```

In `src/worker/index.ts`, construct the store and add it to `defaultDeps`:

```typescript
import { ChromeAutoSaveSettingStore } from "./settings/AutoSaveSettingStore";

const autoSaveSettings = new ChromeAutoSaveSettingStore();
// in defaultDeps:
  autoSaveSettings,
```

Run: `pnpm test src/worker/handlers.test.ts` — expected PASS.

- [ ] **Step 8: Write failing AutoSaveService gate tests**

In `src/worker/services/AutoSaveService.test.ts`, every `new AutoSaveService(alarm, session, tab, capture, dedupe, dwellMs?)` gains a 6th argument **before** `dwellMs` — the enabled port. If the file has a factory/helper, change it there; otherwise update each construction:

```typescript
const enabledPort = { isEnabled: vi.fn().mockResolvedValue(true) };
// new AutoSaveService(alarm, session, tab, capture, dedupe, enabledPort, dwellMs)
```

New tests:

```typescript
  it("does not start a dwell timer when auto-save is disabled", async () => {
    const enabledPort = { isEnabled: vi.fn().mockResolvedValue(false) };
    const alarm = { create: vi.fn(), clear: vi.fn().mockResolvedValue(false) };
    const session = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    const service = new AutoSaveService(
      alarm,
      session,
      { getActiveTabUrl: vi.fn() },
      { saveAuto: vi.fn() },
      { getByUrlHash: vi.fn() },
      enabledPort,
      1000,
    );

    await service.startDwell(1, "https://github.com/some/repo");

    expect(alarm.create).not.toHaveBeenCalled();
    expect(session.set).not.toHaveBeenCalled();
  });

  it("starts a dwell timer when auto-save is enabled", async () => {
    const enabledPort = { isEnabled: vi.fn().mockResolvedValue(true) };
    const alarm = { create: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(false) };
    const session = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined), remove: vi.fn() };
    const service = new AutoSaveService(
      alarm,
      session,
      { getActiveTabUrl: vi.fn() },
      { saveAuto: vi.fn() },
      { getByUrlHash: vi.fn() },
      enabledPort,
      1000,
    );

    await service.startDwell(1, "https://github.com/some/repo");

    expect(alarm.create).toHaveBeenCalledTimes(1);
  });
```

(Adapt mock shapes to the existing test file's conventions — the existing tests show the exact port stubs in use.)

Run: `pnpm test src/worker/services/AutoSaveService.test.ts` — expected FAIL (constructor arity / gate missing).

- [ ] **Step 9: Implement the gate**

In `src/worker/services/AutoSaveService.ts`:

```typescript
export type AutoSaveEnabledPort = {
  isEnabled(): Promise<boolean>;
};

// constructor gains the port before dwellMs:
  constructor(
    private readonly alarm: AlarmPort,
    private readonly session: SessionStoragePort,
    private readonly tab: TabQueryPort,
    private readonly capture: AutoSaveCapturePort,
    private readonly dedupe: AutoSaveDedupePort,
    private readonly enabled: AutoSaveEnabledPort,
    private readonly dwellMs: number = 30_000,
  ) {}

// startDwell gains the gate as its first check:
  async startDwell(tabId: number, url: string): Promise<void> {
    if (!(await this.enabled.isEnabled())) {
      return; // Auto-save is opt-in; off by default.
    }
    if (!isAllowlisted(url)) {
      return;
    }
    // ...rest unchanged...
  }
```

In `src/worker/index.ts`, pass the port:

```typescript
const autoSaveService = new AutoSaveService(
  chromeAlarmPort,
  chromeSessionPort,
  chromeTabPort,
  { saveAuto: /* unchanged */ },
  { getByUrlHash: (urlHash: string) => pageRepo.getByUrlHash(urlHash) },
  { isEnabled: () => autoSaveSettings.isEnabled() },
);
```

- [ ] **Step 10: Full suite, bump, commit**

Run: `pnpm test && pnpm typecheck && pnpm lint` — expected all green.
Version → `0.5.7.2` in both files.

```bash
git add src/shared/allowlist.ts src/shared/messages.ts src/worker/settings/AutoSaveSettingStore.ts src/worker/settings/AutoSaveSettingStore.test.ts src/worker/handlers.ts src/worker/handlers.test.ts src/worker/services/AutoSaveService.ts src/worker/services/AutoSaveService.test.ts src/worker/index.ts package.json
git commit -m "feat: auto-save opt-in flag (off by default), gate dwell timers"
```

---

### Task 4: Options — functional auto-save toggle + allowlist display

**Files:**
- Modify: `src/options/Options.tsx`
- Modify: `src/options/Options.test.tsx`
- Modify: `package.json`, `src/shared/messages.ts` (version → `0.5.7.3`)

- [ ] **Step 1: Write failing tests**

Add to `src/options/Options.test.tsx` (follow the file's existing render-with-injected-props pattern):

```tsx
  it("renders the auto-save toggle from the stored flag", async () => {
    render(
      <Options
        {...baseProps}
        loadAutoSave={async () => true}
        setAutoSave={async () => {}}
      />,
    );

    const checkbox = await screen.findByRole("checkbox", { name: /enable auto-save/i });
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(checkbox).toBeEnabled();
  });

  it("persists the flag when toggled", async () => {
    const setAutoSave = vi.fn().mockResolvedValue(undefined);
    render(
      <Options {...baseProps} loadAutoSave={async () => false} setAutoSave={setAutoSave} />,
    );

    const checkbox = await screen.findByRole("checkbox", { name: /enable auto-save/i });
    await userEvent.click(checkbox);

    expect(setAutoSave).toHaveBeenCalledWith(true);
  });

  it("lists the allowlisted domains", async () => {
    render(
      <Options {...baseProps} loadAutoSave={async () => false} setAutoSave={async () => {}} />,
    );

    expect(await screen.findByText("github.com")).toBeInTheDocument();
    expect(screen.getByText("stackoverflow.com")).toBeInTheDocument();
    expect(screen.getByText("*.readthedocs.io")).toBeInTheDocument();
  });
```

(`baseProps` = whatever minimal prop set the existing tests pass; reuse the file's helper if one exists.)

Run: `pnpm test src/options/Options.test.tsx` — expected FAIL.

- [ ] **Step 2: Implement the toggle in `Options.tsx`**

Add props + defaults:

```typescript
import { ALLOWLIST_DISPLAY } from "../shared/allowlist";

// in OptionsProps:
  loadAutoSave?: () => Promise<boolean>;
  setAutoSave?: (enabled: boolean) => Promise<void>;

// defaults:
const defaultLoadAutoSave = async (): Promise<boolean> => {
  const response = await sendRequest({ type: "settings.getAutoSave" }, "settings.autoSave");
  return response?.payload.enabled ?? false;
};

const defaultSetAutoSave = async (enabled: boolean): Promise<void> => {
  await sendRequest(
    { type: "settings.setAutoSave", payload: { enabled } },
    "settings.autoSaveSet",
  );
};
```

State + load effect inside the component:

```typescript
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);

  useEffect(() => {
    loadAutoSave()
      .then(setAutoSaveEnabled)
      .catch(() => {});
  }, [loadAutoSave]);

  const handleToggleAutoSave = async () => {
    const next = !autoSaveEnabled;
    setAutoSaveEnabled(next);
    try {
      await setAutoSave(next);
    } catch {
      setAutoSaveEnabled(!next); // roll back on failure
    }
  };
```

Replace the disabled-checkbox block (`<label ...><input type="checkbox" disabled .../>Enable auto-save</label>`) with a section:

```tsx
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
            When enabled, pages you read for 30+ seconds on these technical sites are
            saved automatically:
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
```

- [ ] **Step 3: Run, bump, commit**

Run: `pnpm test src/options/Options.test.tsx && pnpm test && pnpm typecheck && pnpm lint` — expected all green.
Version → `0.5.7.3`.

```bash
git add src/options/Options.tsx src/options/Options.test.tsx package.json src/shared/messages.ts
git commit -m "feat: functional auto-save toggle with allowlist display in Options"
```

---

### Task 5: Remove the popup — icon opens the side panel

**Files:**
- Delete: `src/popup/` (index.html, main.tsx, Popup.tsx, Popup.test.tsx)
- Modify: `manifest.config.ts`
- Modify: `src/worker/index.ts`
- Modify: `package.json`, `src/shared/messages.ts` (version → `0.5.7.4`)

- [ ] **Step 1: Remove the popup from the manifest**

In `manifest.config.ts`, the `action` block becomes:

```typescript
  action: {
    default_title: "DevRecall",
  },
```

(`default_popup` removed — required for `openPanelOnActionClick` to take effect.)

- [ ] **Step 2: Register the panel-on-click behavior in the worker**

In `src/worker/index.ts`, alongside the other top-level registrations:

```typescript
if (typeof chrome !== "undefined" && chrome.sidePanel?.setPanelBehavior) {
  // Toolbar icon opens the side panel directly (no popup in v1.0).
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
```

- [ ] **Step 3: Delete the popup**

```bash
git rm -r src/popup
```

- [ ] **Step 4: Verify build and suite**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all green; `dist/manifest.json` has no `default_popup`. If `tsconfig`/eslint reference popup paths explicitly (they don't today), clean those up.

- [ ] **Step 5: Bump and commit**

Version → `0.5.7.4`.

```bash
git add -A
git commit -m "feat: remove popup; toolbar icon opens the side panel"
```

---

### Task 6: SaveBar — "Save this page" moves into the side panel

**Files:**
- Create: `src/sidepanel/SaveBar.tsx`
- Create: `src/sidepanel/SaveBar.test.tsx`
- Modify: `src/sidepanel/App.tsx` (render `<SaveBar />` above the search input)
- Modify: `package.json`, `src/shared/messages.ts` (version → `0.5.7.5`)

- [ ] **Step 1: Write failing tests**

Create `src/sidepanel/SaveBar.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SaveBar } from "./SaveBar";

const tab = { tabId: 7, title: "Using chrome.alarms", url: "https://developer.chrome.com/docs/extensions/reference/api/alarms" };

function makeProps(overrides: Partial<Parameters<typeof SaveBar>[0]> = {}) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(tab),
    saveTab: vi.fn().mockResolvedValue(undefined),
    checkApiKey: vi.fn().mockResolvedValue(true),
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
    render(<SaveBar {...makeProps({ saveTab })} />);

    await userEvent.click(await screen.findByRole("button", { name: /save to library/i }));

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

    expect(
      await screen.findByRole("button", { name: /save failed — try again/i }),
    ).toBeEnabled();
  });

  it("disables save and shows a hint when no API key is set", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(false);
    render(<SaveBar {...makeProps({ checkApiKey })} />);

    expect(await screen.findByRole("button", { name: /save to library/i })).toBeDisabled();
    expect(screen.getByText(/set api key in settings/i)).toBeInTheDocument();
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
});
```

Run: `pnpm test src/sidepanel/SaveBar.test.tsx` — expected FAIL (module missing).

- [ ] **Step 2: Implement `src/sidepanel/SaveBar.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";

import type { DevRecallResponse, WorkerBroadcast } from "../shared/messages";
import { sendRequest, subscribeToBroadcasts } from "../ui/rpc";

export type UrlStatus = Extract<DevRecallResponse, { type: "page.urlStatus" }>["payload"];

type ActiveTab = { tabId: number; title: string; url: string };

type SaveBarProps = {
  getActiveTab?: () => Promise<ActiveTab | null>;
  saveTab?: (tabId: number) => Promise<void>;
  checkApiKey?: () => Promise<boolean>;
  loadUrlStatus?: (url: string) => Promise<UrlStatus>;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
  onTabChange?: (handler: () => void) => () => void;
};

async function defaultGetActiveTab(): Promise<ActiveTab | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    return null;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== "number" || !tab.url) {
    return null;
  }
  return { tabId: tab.id, title: tab.title ?? tab.url, url: tab.url };
}

async function defaultSaveTab(tabId: number): Promise<void> {
  const response = await sendRequest(
    { type: "page.save", payload: { tabId } },
    "page.saved",
  );
  if (!response) {
    throw new Error("Save failed");
  }
}

async function defaultCheckApiKey(): Promise<boolean> {
  const response = await sendRequest({ type: "settings.getStatus" }, "settings.status");
  return response?.payload.hasApiKey ?? false;
}

async function defaultLoadUrlStatus(url: string): Promise<UrlStatus> {
  const response = await sendRequest(
    { type: "page.statusForUrl", payload: { url } },
    "page.urlStatus",
  );
  return response?.payload ?? { saved: false };
}

function defaultOnTabChange(handler: () => void): () => void {
  if (typeof chrome === "undefined" || !chrome.tabs?.onActivated) {
    return () => {};
  }
  const onActivated = () => handler();
  const onUpdated = (_tabId: number, changeInfo: { status?: string }) => {
    if (changeInfo.status === "complete") {
      handler();
    }
  };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
}

function formatRelativeTime(savedAt: number): string {
  const seconds = Math.floor((Date.now() - savedAt) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SaveBar({
  getActiveTab = defaultGetActiveTab,
  saveTab = defaultSaveTab,
  checkApiKey = defaultCheckApiKey,
  loadUrlStatus = defaultLoadUrlStatus,
  subscribe = subscribeToBroadcasts,
  onTabChange = defaultOnTabChange,
}: SaveBarProps) {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [urlStatus, setUrlStatus] = useState<UrlStatus>({ saved: false });
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const refresh = useCallback(async () => {
    const nextTab = await getActiveTab();
    setTab(nextTab);
    setUrlStatus(nextTab ? await loadUrlStatus(nextTab.url) : { saved: false });
  }, [getActiveTab, loadUrlStatus]);

  useEffect(() => {
    void checkApiKey().then(setHasApiKey);
  }, [checkApiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The worker broadcasts page.updated as processing progresses; re-resolve the
  // status for the current tab instead of polling (the popup used a 2 s poll).
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === "page.updated" || message.type === "library.cleared") {
        void refresh();
      }
    });
    return unsubscribe;
  }, [subscribe, refresh]);

  useEffect(() => {
    const unsubscribe = onTabChange(() => {
      setSaving(false);
      setSaveFailed(false);
      void refresh();
    });
    return unsubscribe;
  }, [onTabChange, refresh]);

  if (!tab) {
    return null;
  }

  const handleSave = async () => {
    setSaving(true);
    setSaveFailed(false);
    try {
      await saveTab(tab.tabId);
      await refresh();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  let domain = "";
  try {
    domain = new URL(tab.url).hostname;
  } catch {
    domain = tab.url;
  }

  const missingKey = hasApiKey === false;

  let buttonLabel: string;
  let disabled: boolean;
  if (saving) {
    buttonLabel = "Saving…";
    disabled = true;
  } else if (urlStatus.saved && urlStatus.status === "pending") {
    buttonLabel = "Processing…";
    disabled = true;
  } else if (urlStatus.saved && urlStatus.status === "ready") {
    buttonLabel = `Saved ✓ ${formatRelativeTime(urlStatus.savedAt)}`;
    disabled = true;
  } else if ((urlStatus.saved && urlStatus.status === "failed") || saveFailed) {
    buttonLabel = "Save failed — try again";
    disabled = missingKey;
  } else {
    buttonLabel = "Save to library";
    disabled = hasApiKey === null || missingKey;
  }

  return (
    <section className="rounded-md border border-default bg-surface-raised px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-foreground/55">
        Reading now
      </p>
      <p className="mt-1 truncate font-serif text-sm font-semibold text-foreground">
        {tab.title}
      </p>
      <p className="text-xs text-foreground/55">{domain}</p>
      <button
        type="button"
        disabled={disabled}
        onClick={handleSave}
        className="mt-2 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:bg-foreground/15 disabled:text-foreground/55 disabled:hover:bg-foreground/15"
      >
        {buttonLabel}
      </button>
      {missingKey && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          Set API key in settings
        </p>
      )}
    </section>
  );
}
```

Run: `pnpm test src/sidepanel/SaveBar.test.tsx` — expected PASS.

- [ ] **Step 3: Render it in the side panel**

In `src/sidepanel/App.tsx`, import and place it as the first child of the `flex flex-col gap-4` container, above the search input:

```tsx
import { SaveBar } from "./SaveBar";
// ...
      <div className="flex flex-col gap-4">
        <SaveBar />
        <input type="search" ... />
```

(With default props in jsdom, `getActiveTab` resolves null and SaveBar renders nothing — existing App tests are unaffected.)

- [ ] **Step 4: Full suite, bump, commit**

Run: `pnpm test && pnpm typecheck && pnpm lint` — expected all green.
Version → `0.5.7.5`.

```bash
git add src/sidepanel/SaveBar.tsx src/sidepanel/SaveBar.test.tsx src/sidepanel/App.tsx package.json src/shared/messages.ts
git commit -m "feat: SaveBar in side panel — save current page with live status"
```

---

### Task 7: Readable filter labels

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/App.test.tsx` (any "SO"/"GH" references)
- Modify: `package.json`, `src/shared/messages.ts` (version → `0.5.7.6`)

- [ ] **Step 1: Update the failing test first**

In `src/sidepanel/App.test.tsx`, change every filter-button lookup from `"SO"` → `"Stack Overflow"` and `"GH"` → `"GitHub"` (e.g., `screen.getByRole("button", { name: "Stack Overflow" })`).

Run: `pnpm test src/sidepanel/App.test.tsx` — expected FAIL (buttons not found).

- [ ] **Step 2: Rename the filters**

In `src/sidepanel/App.tsx`:

```typescript
const filters = ["All", "Docs", "Stack Overflow", "GitHub"] as const;
type Filter = (typeof filters)[number];

const filterToSourceType: Record<Exclude<Filter, "All">, SourceType> = {
  Docs: "official_docs",
  "Stack Overflow": "stackoverflow",
  GitHub: "github_issue",
};
```

Run: `pnpm test src/sidepanel/App.test.tsx` — expected PASS.

- [ ] **Step 3: Bump and commit**

Version → `0.5.7.6`.

```bash
git add src/sidepanel/App.tsx src/sidepanel/App.test.tsx package.json src/shared/messages.ts
git commit -m "feat: readable filter labels (Stack Overflow, GitHub)"
```

---

### Task 8: Warm Editorial restyle

**Files:**
- Modify: `src/ui/styles.css`
- Modify: `tailwind.config.js`
- Modify: `src/sidepanel/App.tsx` (pill filters)
- Modify: `src/ui/components/PageCard.tsx`, `src/ui/components/SearchResultCard.tsx`, `src/ui/components/SurfaceShell.tsx` (serif titles)
- Modify: `package.json`, `src/shared/messages.ts` (version → `0.5.7.7`)

This is token-level: behavior tests must stay green untouched. Per the spec (section B4), light = warm paper + terracotta `#9a3412`; dark = warm charcoal + brightened terracotta `#c2562c`; serif for titles only.

- [ ] **Step 1: Swap the CSS variable palettes**

`src/ui/styles.css` `:root` and dark block become:

```css
:root {
  color-scheme: light dark;
  --color-foreground: 41 37 36; /* stone-800 */
  --color-surface: 250 249 247; /* warm paper */
  --color-surface-raised: 255 253 250;
  --color-border-default: 231 226 218;
  --color-accent: 154 52 18; /* terracotta #9a3412 */
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-foreground: 231 229 228; /* stone-200 */
    --color-surface: 28 25 23; /* warm charcoal #1c1917 */
    --color-surface-raised: 38 34 32; /* #262220 */
    --color-border-default: 51 48 44; /* #33302c */
    --color-accent: 194 86 44; /* brightened terracotta #c2562c */
  }
}
```

- [ ] **Step 2: Route `accent` through the variable; drop dead colors**

`tailwind.config.js` theme block becomes:

```javascript
  theme: {
    extend: {
      colors: {
        foreground: "rgb(var(--color-foreground) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        "surface-raised": "rgb(var(--color-surface-raised) / <alpha-value>)",
        default: "rgb(var(--color-border-default) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
      },
      fontFamily: {
        serif: ["Georgia", "ui-serif", "Cambria", "Times New Roman", "serif"],
      },
    },
  },
```

(`ink` and `panel` are referenced nowhere in `src/` — verified — so they're deleted.)

- [ ] **Step 3: Serif titles**

Add `font-serif` to the title elements only:

- `src/ui/components/SurfaceShell.tsx`: `<h1 className="font-serif text-base font-semibold tracking-normal">`
- `src/ui/components/PageCard.tsx`: the collapsed-header `<h2 className="font-serif text-sm font-semibold text-foreground">`
- `src/ui/components/SearchResultCard.tsx`: the `<h2 className="font-serif text-sm font-semibold text-foreground">`
- `src/sidepanel/SaveBar.tsx` already has `font-serif` on the title (Task 6).

- [ ] **Step 4: Pill filters**

In `src/sidepanel/App.tsx`, the filter button className becomes (behavior/aria unchanged):

```tsx
className="rounded-full border border-default bg-surface-raised px-3 py-1 text-sm text-foreground/75 transition-colors hover:bg-foreground/5 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-white"
```

- [ ] **Step 5: Full suite + build, visual sanity**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all green (tests assert behavior and `dark:` variants on status colors, which are untouched).

Then load `/dist` unpacked in Chrome and eyeball both OS themes: warm paper light, warm charcoal dark, terracotta accent everywhere blue used to be, serif titles, pill filters. (Full contrast QA happens in the Task 6 ship pass of the M6 plan.)

- [ ] **Step 6: Bump and commit**

Version → `0.5.7.7`.

```bash
git add src/ui/styles.css tailwind.config.js src/sidepanel/App.tsx src/ui/components/PageCard.tsx src/ui/components/SearchResultCard.tsx src/ui/components/SurfaceShell.tsx package.json src/shared/messages.ts
git commit -m "feat: Warm Editorial theme — warm paper/charcoal palettes, terracotta accent, serif titles"
```

---

### Task 9: Housekeeping — HANDOFF relocation + CLAUDE.md accuracy

**Files:**
- Move: `HANDOFF.md` → `docs/superpowers/handoffs/2026-06-01-m6.md`
- Modify: `CLAUDE.md`

No version bump (docs only).

- [ ] **Step 1: Relocate the handoff**

```bash
mkdir -p docs/superpowers/handoffs
git mv HANDOFF.md docs/superpowers/handoffs/2026-06-01-m6.md
```

- [ ] **Step 2: Update CLAUDE.md**

Make these exact content changes:

1. **Five → Four components.** Heading `### Five-Component Design` → `### Four-Component Design`; update the intro sentence ("five loosely coupled components" → "four loosely coupled components") and the ASCII diagram (drop `Popup`):

```
Content Script → Service Worker ← Side Panel / Options
                      ↓
                 Database (Dexie)
                 LLM Provider (OpenAI)
```

2. **Delete the `#### 3. **Popup**` subsection** entirely; renumber Side Panel and Options. Add to the Side Panel bullet list: `- Hosts the "Save to library" bar (active tab title/domain + live save status via worker broadcasts)`.

3. **Capture pipeline step 1** becomes: `1. **User clicks "Save to library" in the side panel** (or the toolbar icon opens the panel) → panel sends \`page.save\` to worker`.

4. **Options subsection**: replace `- Auto-save toggle (UI placeholder; logic not yet implemented)` with `- Auto-save toggle (opt-in, off by default; allowlisted domains shown) — flag in chrome.storage.local`.

5. **Code Organization**: remove `/src/popup/` from the UI entry points line; add `- \`src/worker/handlers.ts\` — typed RPC dispatcher (pure; unit-tested)` and `- \`/src/ui/rpc.ts\` — shared typed RPC client for UI surfaces`.

6. **Worker section key-file pointer**: `**Key file:** /src/worker/handlers.ts — read this first to understand request/response flow; /src/worker/index.ts is the thin MV3 entry (composition + listeners).`

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/superpowers/handoffs/2026-06-01-m6.md
git commit -m "docs: relocate M6 handoff, update CLAUDE.md for four-surface architecture"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full quality gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm build`
Expected: every command green (pre-existing chunk-size warning on build is acceptable).

- [ ] **Step 2: Coverage gate**

Run: `pnpm test -- --coverage`
Expected: `src/lib/**`, `src/worker/handlers.ts`, `src/worker/services/**`, `src/worker/settings/**` all ≥ 80% statements (the v1.0 gate).

- [ ] **Step 3: Manual E2E in Chrome**

Load `/dist` unpacked and verify:
1. Toolbar icon opens the side panel (no popup).
2. SaveBar shows the active tab; Save → Processing… → Saved ✓.
3. Switching tabs retargets the SaveBar.
4. Filters read All / Docs / Stack Overflow / GitHub and filter both list and search hits.
5. Options: auto-save toggle persists across reloads; allowlist visible; with the toggle OFF, dwelling 30+ s on github.com saves nothing; with it ON, the page auto-saves.
6. Both OS themes look right (warm paper / warm charcoal).

- [ ] **Step 4: Use verification-before-completion, then requesting-code-review**

Invoke the superpowers `verification-before-completion` skill before claiming done, then `requesting-code-review` before merging. After review, the M6 plan's remaining ship steps apply (demo GIF, version → `1.0.0.0`, tag `v1.0` — tag only with explicit human confirmation).
