/**
 * AutoSaveService unit tests.
 *
 * All chrome.alarms / chrome.storage.session calls are replaced with injected
 * fakes so these tests run in jsdom without real Chrome APIs and without
 * waiting a real 30 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageRecord } from "../../shared/types";
import {
  AutoSaveService,
  ALLOWLIST_PATTERNS,
  chromeSessionPort,
  chromeTabPort,
  type AlarmPort,
  type SessionStoragePort,
  type TabQueryPort,
} from "./AutoSaveService";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ALLOWLISTED_URL = "https://github.com/some/repo";
const NON_ALLOWLISTED_URL = "https://example.com/page";
const TAB_ID = 42;

const readyPage: PageRecord = {
  id: "01HZ0000000000000000000000",
  url: ALLOWLISTED_URL,
  urlHash: "a".repeat(64),
  title: "GitHub Repo",
  domain: "github.com",
  sourceType: "unknown",
  summary: "",
  topics: [],
  technologies: [],
  intent: "reference",
  fullText: "GitHub repo content.",
  savedAt: 1,
  visitedAt: 1,
  readingTimeMs: 10_000,
  saveMode: "auto",
  status: "ready",
  schemaVersion: 1,
};

const pendingPage: PageRecord = { ...readyPage, status: "pending" };

// ---------------------------------------------------------------------------
// Factory helpers for injected ports
// ---------------------------------------------------------------------------

function makeAlarmPort(overrides: Partial<AlarmPort> = {}): AlarmPort {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeSessionPort(overrides: Partial<SessionStoragePort> = {}): SessionStoragePort {
  const store: Record<string, unknown> = {};
  return {
    get: vi.fn().mockImplementation(async (key: string) => store[key]),
    set: vi.fn().mockImplementation(async (key: string, value: unknown) => {
      store[key] = value;
    }),
    remove: vi.fn().mockImplementation(async (key: string) => {
      delete store[key];
    }),
    ...overrides,
  };
}

function makeTabPort(url: string = ALLOWLISTED_URL): TabQueryPort {
  return {
    getActiveTabUrl: vi.fn().mockResolvedValue(url),
  };
}

import type {
  AutoSaveCapturePort,
  AutoSaveDedupePort,
  AutoSaveEnabledPort,
} from "./AutoSaveService";

type CapturePortMini = AutoSaveCapturePort & {
  saveAuto: ReturnType<typeof vi.fn> & AutoSaveCapturePort["saveAuto"];
};

function makeCapturePort(page: PageRecord = pendingPage): CapturePortMini {
  const fn = vi.fn().mockResolvedValue(page) as unknown as CapturePortMini["saveAuto"];
  return { saveAuto: fn };
}

type DedupePortMini = AutoSaveDedupePort & {
  getByUrlHash: ReturnType<typeof vi.fn> & AutoSaveDedupePort["getByUrlHash"];
};

function makeDedupePort(existing: PageRecord | undefined = undefined): DedupePortMini {
  const fn = vi.fn().mockResolvedValue(existing) as unknown as DedupePortMini["getByUrlHash"];
  return { getByUrlHash: fn };
}

// ---------------------------------------------------------------------------
// Helper to build a service with convenient defaults
// ---------------------------------------------------------------------------

function makeEnabledPort(enabled = true): AutoSaveEnabledPort {
  return { isEnabled: vi.fn().mockResolvedValue(enabled) };
}

function buildService({
  alarm = makeAlarmPort(),
  session = makeSessionPort(),
  tab = makeTabPort(),
  capture = makeCapturePort(),
  dedupe = makeDedupePort(),
  enabled = makeEnabledPort(true),
  dwellMs = 30_000,
}: {
  alarm?: AlarmPort;
  session?: SessionStoragePort;
  tab?: TabQueryPort;
  capture?: CapturePortMini;
  dedupe?: DedupePortMini;
  enabled?: AutoSaveEnabledPort;
  dwellMs?: number;
} = {}) {
  const service = new AutoSaveService(
    alarm,
    session,
    tab,
    { saveAuto: capture.saveAuto },
    { getByUrlHash: dedupe.getByUrlHash },
    enabled,
    dwellMs,
  );
  return { service, alarm, session, tab, capture, dedupe };
}

// ---------------------------------------------------------------------------
// ALLOWLIST_PATTERNS sanity checks
// ---------------------------------------------------------------------------

describe("ALLOWLIST_PATTERNS", () => {
  const shouldMatch = [
    "https://github.com/some/repo",
    "https://www.github.com/org",
    "https://stackoverflow.com/questions/1234",
    "https://developer.mozilla.org/en-US/docs",
    "https://docs.example.com/guide",
    "https://myproject.readthedocs.io/en/latest/",
    "https://www.npmjs.com/package/vite",
    "https://www.rust-lang.org/learn",
    "https://www.python.org/docs/",
    "http://docs.internal.example.com/",
  ];

  const shouldNotMatch = [
    "https://example.com/page",
    "https://twitter.com/user",
    "https://reddit.com/r/programming",
    "https://medium.com/article",
  ];

  it.each(shouldMatch)("matches allowlisted URL: %s", (url) => {
    expect(ALLOWLIST_PATTERNS.some((p) => p.test(url))).toBe(true);
  });

  it.each(shouldNotMatch)("does not match non-allowlisted URL: %s", (url) => {
    expect(ALLOWLIST_PATTERNS.some((p) => p.test(url))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startDwell
// ---------------------------------------------------------------------------

describe("AutoSaveService.startDwell", () => {
  it("creates an alarm and persists session state for an allowlisted URL", async () => {
    const { service, alarm, session } = buildService();

    await service.startDwell(TAB_ID, ALLOWLISTED_URL);

    expect(alarm.create).toHaveBeenCalledWith(`autosave:${TAB_ID}`, expect.any(Number));
    expect(session.set).toHaveBeenCalledWith(`autosave:${TAB_ID}`, {
      url: ALLOWLISTED_URL,
      startedAt: expect.any(Number),
    });
  });

  it("does NOT create an alarm for a non-allowlisted URL", async () => {
    const { service, alarm, session } = buildService();

    await service.startDwell(TAB_ID, NON_ALLOWLISTED_URL);

    expect(alarm.create).not.toHaveBeenCalled();
    expect(session.set).not.toHaveBeenCalled();
  });

  it("clears any existing alarm before starting a new one (idempotent)", async () => {
    const { service, alarm } = buildService();

    await service.startDwell(TAB_ID, ALLOWLISTED_URL);

    expect(alarm.clear).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
    expect(alarm.create).toHaveBeenCalledWith(`autosave:${TAB_ID}`, expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// cancelDwell
// ---------------------------------------------------------------------------

describe("AutoSaveService.cancelDwell", () => {
  it("clears the alarm and removes the session state", async () => {
    const { service, alarm, session } = buildService();

    await service.cancelDwell(TAB_ID);

    expect(alarm.clear).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
    expect(session.remove).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
  });
});

// ---------------------------------------------------------------------------
// onAlarmFired — happy path
// ---------------------------------------------------------------------------

describe("AutoSaveService.onAlarmFired — happy path", () => {
  it("captures the page when tab is still on the same allowlisted URL", async () => {
    const sessionStore: Record<string, unknown> = {
      [`autosave:${TAB_ID}`]: { url: ALLOWLISTED_URL, startedAt: Date.now() },
    };
    const session = makeSessionPort({
      get: vi.fn().mockImplementation(async (key: string) => sessionStore[key]),
      remove: vi.fn().mockImplementation(async (key: string) => {
        delete sessionStore[key];
      }),
    });
    const tab = makeTabPort(ALLOWLISTED_URL);
    const capture = makeCapturePort();

    const { service } = buildService({ session, tab, capture });

    await service.onAlarmFired(`autosave:${TAB_ID}`);

    expect(capture.saveAuto).toHaveBeenCalledWith(TAB_ID);
  });

  it("clears session state after a successful capture", async () => {
    const sessionStore: Record<string, unknown> = {
      [`autosave:${TAB_ID}`]: { url: ALLOWLISTED_URL, startedAt: Date.now() },
    };
    const session = makeSessionPort({
      get: vi.fn().mockImplementation(async (key: string) => sessionStore[key]),
      remove: vi.fn().mockImplementation(async (key: string) => {
        delete sessionStore[key];
      }),
    });

    const { service } = buildService({ session });

    await service.onAlarmFired(`autosave:${TAB_ID}`);

    expect(session.remove).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
  });
});

// ---------------------------------------------------------------------------
// onAlarmFired — re-verify guards
// ---------------------------------------------------------------------------

describe("AutoSaveService.onAlarmFired — re-verify guards", () => {
  it("does NOT capture if no session entry exists (worker was restarted without state)", async () => {
    const session = makeSessionPort({
      get: vi.fn().mockResolvedValue(undefined),
    });
    const capture = makeCapturePort();

    const { service } = buildService({ session, capture });

    await service.onAlarmFired(`autosave:${TAB_ID}`);

    expect(capture.saveAuto).not.toHaveBeenCalled();
  });

  it("does NOT capture if the tab has navigated to a different URL before alarm fires", async () => {
    const session = makeSessionPort({
      get: vi.fn().mockResolvedValue({ url: ALLOWLISTED_URL, startedAt: Date.now() }),
      remove: vi.fn().mockResolvedValue(undefined),
    });
    // Tab is now on a different URL
    const tab = makeTabPort("https://github.com/different/page");
    const capture = makeCapturePort();

    const { service } = buildService({ session, tab, capture });

    await service.onAlarmFired(`autosave:${TAB_ID}`);

    expect(capture.saveAuto).not.toHaveBeenCalled();
  });

  it("does NOT capture if the tab has navigated to a non-allowlisted URL", async () => {
    const session = makeSessionPort({
      get: vi.fn().mockResolvedValue({ url: ALLOWLISTED_URL, startedAt: Date.now() }),
      remove: vi.fn().mockResolvedValue(undefined),
    });
    const tab = makeTabPort(NON_ALLOWLISTED_URL);
    const capture = makeCapturePort();

    const { service } = buildService({ session, tab, capture });

    await service.onAlarmFired(`autosave:${TAB_ID}`);

    expect(capture.saveAuto).not.toHaveBeenCalled();
  });

  it("ignores alarms that do not have the autosave: prefix", async () => {
    const session = makeSessionPort();
    const capture = makeCapturePort();

    const { service } = buildService({ session, capture });

    await service.onAlarmFired("some-other-alarm");

    expect(session.get).not.toHaveBeenCalled();
    expect(capture.saveAuto).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dedup guard
// ---------------------------------------------------------------------------

describe("AutoSaveService.onAlarmFired — dedup", () => {
  it("skips capture when the page is already saved with status 'ready'", async () => {
    const session = makeSessionPort({
      get: vi.fn().mockResolvedValue({ url: ALLOWLISTED_URL, startedAt: Date.now() }),
      remove: vi.fn().mockResolvedValue(undefined),
    });
    const tab = makeTabPort(ALLOWLISTED_URL);
    const capture = makeCapturePort();
    // Page already in DB as ready
    const dedupe = makeDedupePort(readyPage);

    const { service } = buildService({ session, tab, capture, dedupe });

    await service.onAlarmFired(`autosave:${TAB_ID}`);

    expect(capture.saveAuto).not.toHaveBeenCalled();
  });

  it("DOES capture when the page exists but status is 'failed' (retry is allowed)", async () => {
    const session = makeSessionPort({
      get: vi.fn().mockResolvedValue({ url: ALLOWLISTED_URL, startedAt: Date.now() }),
      remove: vi.fn().mockResolvedValue(undefined),
    });
    const tab = makeTabPort(ALLOWLISTED_URL);
    const capture = makeCapturePort();
    const failedPage: PageRecord = { ...readyPage, status: "failed" };
    const dedupe = makeDedupePort(failedPage);

    const { service } = buildService({ session, tab, capture, dedupe });

    await service.onAlarmFired(`autosave:${TAB_ID}`);

    expect(capture.saveAuto).toHaveBeenCalledWith(TAB_ID);
  });

  it("DOES capture when the page does not exist in the DB yet", async () => {
    const session = makeSessionPort({
      get: vi.fn().mockResolvedValue({ url: ALLOWLISTED_URL, startedAt: Date.now() }),
      remove: vi.fn().mockResolvedValue(undefined),
    });
    const tab = makeTabPort(ALLOWLISTED_URL);
    const capture = makeCapturePort();
    const dedupe = makeDedupePort(undefined); // no existing page

    const { service } = buildService({ session, tab, capture, dedupe });

    await service.onAlarmFired(`autosave:${TAB_ID}`);

    expect(capture.saveAuto).toHaveBeenCalledWith(TAB_ID);
  });
});

// ---------------------------------------------------------------------------
// onTabActivated / onTabUpdated integration
// ---------------------------------------------------------------------------

describe("AutoSaveService.onTabActivated", () => {
  it("starts a dwell when the activated tab has an allowlisted URL", async () => {
    const { service, alarm, session } = buildService({
      tab: makeTabPort(ALLOWLISTED_URL),
    });

    await service.onTabActivated(TAB_ID);

    expect(alarm.create).toHaveBeenCalledWith(`autosave:${TAB_ID}`, expect.any(Number));
    expect(session.set).toHaveBeenCalled();
  });

  it("cancels any existing dwell when switching away from a tab", async () => {
    // Simulate: previously dwelling on TAB_ID=42, then user switches to TAB_ID=99
    const { service, alarm, session } = buildService({
      tab: makeTabPort(ALLOWLISTED_URL),
    });

    // Start a dwell on 42 first
    await service.startDwell(TAB_ID, ALLOWLISTED_URL);
    vi.clearAllMocks();

    // Now activate a different tab (99 is passed, but the old dwell for 42 should be cancelled)
    await service.onTabActivated(99);

    // Old tab's alarm must be cleared
    expect(alarm.clear).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
    expect(session.remove).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
  });
});

describe("AutoSaveService.onTabUpdated", () => {
  it("starts a dwell when a tab finishes loading an allowlisted URL", async () => {
    const { service, alarm, session } = buildService();

    await service.onTabUpdated(TAB_ID, "complete", ALLOWLISTED_URL);

    expect(alarm.create).toHaveBeenCalled();
    expect(session.set).toHaveBeenCalled();
  });

  it("does NOT start a dwell when the status is still 'loading'", async () => {
    const { service, alarm } = buildService();

    await service.onTabUpdated(TAB_ID, "loading", ALLOWLISTED_URL);

    expect(alarm.create).not.toHaveBeenCalled();
  });

  it("cancels any in-progress dwell when the URL changes on the same tab", async () => {
    const { service, alarm } = buildService();

    // Establish a prior dwell
    await service.startDwell(TAB_ID, ALLOWLISTED_URL);
    vi.clearAllMocks();

    // Same tab navigates to a different page
    await service.onTabUpdated(TAB_ID, "complete", "https://github.com/new/page");

    // The old alarm must be cleared before starting the new dwell
    expect(alarm.clear).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
  });
});

// ---------------------------------------------------------------------------
// onTabRemoved
// ---------------------------------------------------------------------------

describe("AutoSaveService.onTabRemoved", () => {
  it("cancels dwell when tab is removed", async () => {
    const { service, alarm, session } = buildService();

    // Start a dwell for the tab first
    await service.startDwell(TAB_ID, ALLOWLISTED_URL);
    vi.clearAllMocks();

    // Tab is removed
    await service.onTabRemoved(TAB_ID);

    // Both alarm and session entry must be cleaned up
    expect(alarm.clear).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
    expect(session.remove).toHaveBeenCalledWith(`autosave:${TAB_ID}`);
  });

  it("clears the currentDwellTabId so switching tabs after removal does not double-cancel", async () => {
    const alarm = makeAlarmPort();
    const session = makeSessionPort();
    const { service } = buildService({
      alarm,
      session,
      tab: makeTabPort(ALLOWLISTED_URL),
    });

    // Start a dwell on TAB_ID to set currentDwellTabId
    await service.startDwell(TAB_ID, ALLOWLISTED_URL);
    vi.clearAllMocks();

    // Remove that tab — this must null out currentDwellTabId
    await service.onTabRemoved(TAB_ID);
    vi.clearAllMocks();

    // Activating a different tab: since currentDwellTabId is now null, the service
    // should NOT call cancelDwell for the already-removed TAB_ID.
    // The only alarm.clear allowed is the one inside startDwell for the NEW tab (99).
    await service.onTabActivated(99);

    const clearCalls = (alarm.clear as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(clearCalls.every((name) => name !== `autosave:${TAB_ID}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auto-save enabled gate
// ---------------------------------------------------------------------------

describe("AutoSaveService.startDwell — enabled gate", () => {
  it("does not start a dwell timer when auto-save is disabled", async () => {
    const alarm = makeAlarmPort();
    const session = makeSessionPort();
    const { service } = buildService({
      alarm,
      session,
      enabled: makeEnabledPort(false),
    });

    await service.startDwell(TAB_ID, ALLOWLISTED_URL);

    expect(alarm.create).not.toHaveBeenCalled();
    expect(session.set).not.toHaveBeenCalled();
  });

  it("starts a dwell timer when auto-save is enabled", async () => {
    const alarm = makeAlarmPort();
    const { service } = buildService({
      alarm,
      enabled: makeEnabledPort(true),
    });

    await service.startDwell(TAB_ID, ALLOWLISTED_URL);

    expect(alarm.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// chromeSessionPort — production port backed by chrome.storage.session
// ---------------------------------------------------------------------------

describe("chromeSessionPort", () => {
  const KEY = "autosave:123";
  const VALUE = { url: "https://github.com/test", startedAt: 1000 };

  beforeEach(() => {
    const store: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>)["chrome"] = {
      storage: {
        session: {
          get: vi.fn().mockImplementation(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn().mockImplementation(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
          remove: vi.fn().mockImplementation(async (key: string) => {
            delete store[key];
          }),
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["chrome"];
  });

  it("set stores a value and get retrieves it", async () => {
    await chromeSessionPort.set(KEY, VALUE);
    const result = await chromeSessionPort.get(KEY);
    expect(result).toEqual(VALUE);
  });

  it("remove deletes the stored value", async () => {
    await chromeSessionPort.set(KEY, VALUE);
    await chromeSessionPort.remove(KEY);
    const result = await chromeSessionPort.get(KEY);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// chromeTabPort — production port backed by chrome.tabs
// ---------------------------------------------------------------------------

describe("chromeTabPort", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)["chrome"] = {
      tabs: {
        get: vi.fn(),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["chrome"];
  });

  it("returns the tab URL when the tab exists", async () => {
    const chromeMock = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { get: ReturnType<typeof vi.fn> };
    };
    chromeMock.tabs.get.mockResolvedValue({ url: ALLOWLISTED_URL });

    const result = await chromeTabPort.getActiveTabUrl(TAB_ID);

    expect(result).toBe(ALLOWLISTED_URL);
  });

  it("returns null when chrome.tabs.get throws (tab no longer exists)", async () => {
    const chromeMock = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { get: ReturnType<typeof vi.fn> };
    };
    chromeMock.tabs.get.mockRejectedValue(new Error("No tab with id 42"));

    const result = await chromeTabPort.getActiveTabUrl(TAB_ID);

    expect(result).toBeNull();
  });

  it("returns null when the tab has no url property", async () => {
    const chromeMock = (globalThis as Record<string, unknown>)["chrome"] as {
      tabs: { get: ReturnType<typeof vi.fn> };
    };
    chromeMock.tabs.get.mockResolvedValue({ url: undefined });

    const result = await chromeTabPort.getActiveTabUrl(TAB_ID);

    expect(result).toBeNull();
  });
});
