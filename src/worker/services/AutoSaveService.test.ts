/**
 * AutoSaveService unit tests.
 *
 * All chrome.alarms / chrome.storage.session calls are replaced with injected
 * fakes so these tests run in jsdom without real Chrome APIs and without
 * waiting a real 30 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageRecord } from "../../shared/types";
import { ContentType, Platform } from "../../shared/enums";
import {
  AutoSaveService,
  chromeAlarmPort,
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
  platform: Platform.Github,
  contentType: ContentType.Repository,
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
  const names = new Set<string>();
  return {
    create: vi.fn().mockImplementation(async (name: string) => {
      names.add(name);
    }),
    clear: vi.fn().mockImplementation(async (name: string) => names.delete(name)),
    getAllNames: vi.fn().mockImplementation(async () => [...names]),
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

/** Every tab reports `url` as the active tab of its window. */
function makeTabPort(url: string = ALLOWLISTED_URL): TabQueryPort {
  return {
    getActiveTabUrl: vi.fn().mockResolvedValue(url),
  };
}

/**
 * Browser-like tab state: `activeByWindow` maps each window to its active tab.
 * Window focus is deliberately absent because it does not affect auto-save.
 */
function makeBrowserTabPort(
  urls: Record<number, string>,
  activeByWindow: Record<number, number>,
): TabQueryPort {
  return {
    getActiveTabUrl: vi
      .fn()
      .mockImplementation(async (tabId: number) =>
        Object.values(activeByWindow).includes(tabId) ? (urls[tabId] ?? null) : null,
      ),
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

  it.each(["pending", "keyword_ready", "enriching"])(
    "skips capture when the page is already saved with status '%s'",
    async (status) => {
      const session = makeSessionPort({
        get: vi.fn().mockResolvedValue({ url: ALLOWLISTED_URL, startedAt: Date.now() }),
        remove: vi.fn().mockResolvedValue(undefined),
      });
      const tab = makeTabPort(ALLOWLISTED_URL);
      const capture = makeCapturePort();
      const dedupe = makeDedupePort({ ...readyPage, status } as PageRecord);
      const { service } = buildService({ session, tab, capture, dedupe });

      await service.onAlarmFired(`autosave:${TAB_ID}`);

      expect(capture.saveAuto).not.toHaveBeenCalled();
    },
  );

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
    const activeByWindow = { 1: TAB_ID };
    const { service, alarm, session } = buildService({
      tab: makeBrowserTabPort({ [TAB_ID]: ALLOWLISTED_URL, 99: ALLOWLISTED_URL }, activeByWindow),
    });

    // Start a dwell on 42 first
    await service.startDwell(TAB_ID, ALLOWLISTED_URL);
    vi.clearAllMocks();

    // Now activate a different tab in the same window
    activeByWindow[1] = 99;
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
// Only tabs in front dwell
// ---------------------------------------------------------------------------

describe("AutoSaveService — only the active tab of each window dwells", () => {
  const TAB_A = 1;
  const TAB_B = 2;
  const TAB_C = 3;
  const TAB_D = 4;
  const URLS: Record<number, string> = {
    [TAB_A]: "https://github.com/org/issue-a",
    [TAB_B]: "https://github.com/org/background-b",
    [TAB_C]: "https://github.com/org/page-c",
    [TAB_D]: "https://github.com/org/other-window-d",
  };

  function scheduled(alarm: AlarmPort) {
    return alarm.getAllNames();
  }

  /** Fire every pending auto-save alarm, as Chrome does once the dwell time passes. */
  async function fireAll(service: AutoSaveService, alarm: AlarmPort) {
    for (const name of await scheduled(alarm)) {
      await service.onAlarmFired(name);
    }
  }

  it("does not start a dwell when a background tab finishes loading", async () => {
    const { service, alarm, session } = buildService({
      tab: makeBrowserTabPort(URLS, { 1: TAB_A }),
    });

    await service.onTabUpdated(TAB_B, "complete", URLS[TAB_B]);

    expect(alarm.create).not.toHaveBeenCalled();
    expect(session.set).not.toHaveBeenCalled();
  });

  it("never saves a background tab, even after the dwell time", async () => {
    // The finding's scenario: reading A, then Ctrl-clicking B into the background.
    const { service, alarm, capture } = buildService({
      tab: makeBrowserTabPort(URLS, { 1: TAB_A }),
    });

    await service.onTabUpdated(TAB_A, "complete", URLS[TAB_A]);
    await service.onTabUpdated(TAB_B, "complete", URLS[TAB_B]);
    await fireAll(service, alarm);

    expect(capture.saveAuto).toHaveBeenCalledTimes(1);
    expect(capture.saveAuto).toHaveBeenCalledWith(TAB_A);
  });

  it("saves a tab that stays active in an unfocused window", async () => {
    // A is in front of window 1. The user then works in window 2 or another app;
    // neither activates a tab in window 1, so A stays in front there.
    const { service, alarm, capture } = buildService({
      tab: makeBrowserTabPort(URLS, { 1: TAB_A, 2: TAB_D }),
    });

    await service.onTabActivated(TAB_A);
    await fireAll(service, alarm);

    expect(capture.saveAuto).toHaveBeenCalledWith(TAB_A);
  });

  it("cancels the previous tab's dwell on a switch within its window", async () => {
    const activeByWindow = { 1: TAB_A };
    const { service, alarm, capture } = buildService({
      tab: makeBrowserTabPort(URLS, activeByWindow),
    });
    await service.onTabUpdated(TAB_A, "complete", URLS[TAB_A]);

    activeByWindow[1] = TAB_C;
    await service.onTabActivated(TAB_C);
    expect(await scheduled(alarm)).toEqual([`autosave:${TAB_C}`]);

    await fireAll(service, alarm);
    expect(capture.saveAuto).toHaveBeenCalledTimes(1);
    expect(capture.saveAuto).toHaveBeenCalledWith(TAB_C);
  });

  it("keeps another window's dwell when switching tabs in one window", async () => {
    const activeByWindow = { 1: TAB_A, 2: TAB_D };
    const { service, alarm } = buildService({ tab: makeBrowserTabPort(URLS, activeByWindow) });
    await service.onTabActivated(TAB_A);
    await service.onTabActivated(TAB_D);

    activeByWindow[1] = TAB_C;
    await service.onTabActivated(TAB_C);

    expect((await scheduled(alarm)).sort()).toEqual([`autosave:${TAB_C}`, `autosave:${TAB_D}`]);
  });

  it("cancels the previous dwell after a worker restart lost all in-memory state", async () => {
    const alarm = makeAlarmPort();
    const session = makeSessionPort();
    const activeByWindow = { 1: TAB_A };
    const tab = makeBrowserTabPort(URLS, activeByWindow);
    const first = buildService({ alarm, session, tab }).service;
    await first.onTabActivated(TAB_A);

    // MV3 restart: a fresh service instance shares only the alarms and session.
    const restarted = buildService({ alarm, session, tab }).service;
    activeByWindow[1] = TAB_C;
    await restarted.onTabActivated(TAB_C);

    expect(await scheduled(alarm)).toEqual([`autosave:${TAB_C}`]);
    expect(session.remove).toHaveBeenCalledWith(`autosave:${TAB_A}`);
  });

  it("does not start a dwell for a tab that was replaced before the event ran", async () => {
    const { service, alarm } = buildService({ tab: makeBrowserTabPort(URLS, { 1: TAB_C }) });

    await service.onTabActivated(TAB_A);

    expect(alarm.create).not.toHaveBeenCalled();
  });

  it("leaves alarms that are not auto-save alarms alone", async () => {
    const alarm = makeAlarmPort();
    await alarm.create("unrelated-alarm", 0);
    const { service } = buildService({ alarm, tab: makeBrowserTabPort(URLS, { 1: TAB_A }) });

    await service.onTabActivated(TAB_A);

    expect((await scheduled(alarm)).sort()).toEqual([`autosave:${TAB_A}`, "unrelated-alarm"]);
  });

  it("does NOT capture when the tab left the front before the alarm fired", async () => {
    const session = makeSessionPort();
    await session.set(`autosave:${TAB_A}`, { url: URLS[TAB_A], startedAt: Date.now() });
    const capture = makeCapturePort();
    const { service } = buildService({
      session,
      capture,
      tab: makeBrowserTabPort(URLS, { 1: TAB_C }),
    });

    await service.onAlarmFired(`autosave:${TAB_A}`);

    expect(capture.saveAuto).not.toHaveBeenCalled();
    expect(session.remove).toHaveBeenCalledWith(`autosave:${TAB_A}`);
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

  it("leaves nothing for a later tab switch to cancel", async () => {
    const alarm = makeAlarmPort();
    const { service } = buildService({ alarm, tab: makeTabPort(ALLOWLISTED_URL) });

    await service.startDwell(TAB_ID, ALLOWLISTED_URL);
    await service.onTabRemoved(TAB_ID);
    vi.clearAllMocks();

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
  type ChromeMock = {
    tabs: { get: ReturnType<typeof vi.fn> };
  };
  let chromeMock: ChromeMock;

  beforeEach(() => {
    chromeMock = {
      tabs: { get: vi.fn() },
    };
    (globalThis as Record<string, unknown>)["chrome"] = chromeMock;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["chrome"];
  });

  it("returns the tab URL when the tab is active in its window", async () => {
    chromeMock.tabs.get.mockResolvedValue({ url: ALLOWLISTED_URL, active: true, windowId: 5 });

    const result = await chromeTabPort.getActiveTabUrl(TAB_ID);

    expect(result).toBe(ALLOWLISTED_URL);
  });

  it("returns null for a background tab", async () => {
    chromeMock.tabs.get.mockResolvedValue({ url: ALLOWLISTED_URL, active: false, windowId: 5 });

    const result = await chromeTabPort.getActiveTabUrl(TAB_ID);

    expect(result).toBeNull();
  });

  it("does not consult window focus (chrome.windows is unavailable here)", async () => {
    chromeMock.tabs.get.mockResolvedValue({ url: ALLOWLISTED_URL, active: true, windowId: 5 });

    const result = await chromeTabPort.getActiveTabUrl(TAB_ID);

    expect(result).toBe(ALLOWLISTED_URL);
    expect(chromeMock).not.toHaveProperty("windows");
  });

  it("returns null when chrome.tabs.get throws (tab no longer exists)", async () => {
    chromeMock.tabs.get.mockRejectedValue(new Error("No tab with id 42"));

    const result = await chromeTabPort.getActiveTabUrl(TAB_ID);

    expect(result).toBeNull();
  });

  it("returns null when the tab has no url property", async () => {
    chromeMock.tabs.get.mockResolvedValue({ url: undefined, active: true, windowId: 5 });

    const result = await chromeTabPort.getActiveTabUrl(TAB_ID);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// chromeAlarmPort — production port backed by chrome.alarms
// ---------------------------------------------------------------------------

describe("chromeAlarmPort", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["chrome"];
  });

  it("lists the names of every scheduled alarm", async () => {
    (globalThis as Record<string, unknown>)["chrome"] = {
      alarms: {
        getAll: vi.fn().mockResolvedValue([{ name: "autosave:1" }, { name: "other" }]),
      },
    };

    expect(await chromeAlarmPort.getAllNames()).toEqual(["autosave:1", "other"]);
  });
});
