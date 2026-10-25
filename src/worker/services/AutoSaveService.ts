/**
 * AutoSaveService — alarm-driven dwell-based auto-save for allowlisted domains.
 *
 * Design constraints
 * ------------------
 * • The MV3 service worker is killed after ~30 s of inactivity. setTimeout/setInterval
 *   callbacks are dropped when the worker dies. We use chrome.alarms (which wakes the
 *   worker when they fire) and chrome.storage.session (which survives across worker
 *   restarts within the browser session) to make the dwell timer restart-proof.
 *
 * • Chrome enforces a minimum alarm granularity of 30 s (Chrome 120+). The default
 *   dwellMs is exactly 30 000 ms to match that minimum. In tests, dwellMs is passed
 *   as a smaller value — Chrome is not involved there.
 *
 * • All chrome.* calls are hidden behind injectable ports so unit tests never touch
 *   real browser APIs and never wait a real 30 s.
 *
 * • Only a tab in front (the active tab of its window) dwells. Window focus does
 *   not matter, so a page left in front while the user types in another app still
 *   saves. Each window can have one dwelling tab. Tabs that load in the
 *   background never start a timer, and activating a tab cancels the dwell of
 *   any tab that is no longer in front. Alarms cannot pause, so returning to a
 *   tab starts its dwell again from zero.
 *
 * Alarm naming
 * ------------
 *   `autosave:<tabId>`  — one alarm per tab, created on dwell start.
 *
 * Session storage key
 * -------------------
 *   `autosave:<tabId>`  — stores `{ url: string; startedAt: number }`.
 */

import { normalizeUrl } from "../../lib/urlNormalize";
import { isAllowlisted } from "../../shared/allowlist";
import type { PageStatus } from "../../shared/types";

// ---------------------------------------------------------------------------
// Injectable ports (thin wrappers around Chrome APIs in production)
// ---------------------------------------------------------------------------

export type AlarmPort = {
  /** Schedule a one-shot alarm. `when` is a Unix timestamp in ms. */
  create(name: string, when: number): Promise<void>;
  /** Cancel an alarm by name. Resolves to true if the alarm existed. */
  clear(name: string): Promise<boolean>;
  /** Names of every scheduled alarm. */
  getAllNames(): Promise<string[]>;
};

export type SessionStoragePort = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
};

export type TabQueryPort = {
  /**
   * Returns the tab's URL while it is the active tab of its window, whether or
   * not that window is focused. Returns null for background and closed tabs.
   */
  getActiveTabUrl(tabId: number): Promise<string | null>;
};

export type AutoSaveCapturePort = {
  /** Run the capture pipeline with saveMode:'auto' for a given tab. */
  saveAuto(tabId: number): Promise<unknown>;
};

export type AutoSaveDedupePort = {
  /** Look up an existing page by URL hash. Resolves to undefined if not found. */
  getByUrlHash(urlHash: string): Promise<{ status: PageStatus } | undefined>;
};

export type AutoSaveEnabledPort = {
  isEnabled(): Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Session entry shape
// ---------------------------------------------------------------------------

type DwellEntry = { url: string; startedAt: number };

function isDwellEntry(value: unknown): value is DwellEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["url"] === "string" &&
    typeof (value as Record<string, unknown>)["startedAt"] === "number"
  );
}

// ---------------------------------------------------------------------------
// AutoSaveService
// ---------------------------------------------------------------------------

const ALARM_PREFIX = "autosave:";

export class AutoSaveService {
  constructor(
    private readonly alarm: AlarmPort,
    private readonly session: SessionStoragePort,
    private readonly tab: TabQueryPort,
    private readonly capture: AutoSaveCapturePort,
    private readonly dedupe: AutoSaveDedupePort,
    private readonly enabled: AutoSaveEnabledPort,
    /** Dwell duration in ms. Production: 30 000 (Chrome 120+ minimum). */
    private readonly dwellMs: number = 30_000,
  ) {}

  // -------------------------------------------------------------------------
  // Public API used by top-level chrome event listeners in the worker
  // -------------------------------------------------------------------------

  /** Called from chrome.tabs.onActivated. */
  async onTabActivated(tabId: number): Promise<void> {
    // The tab this one replaced in its window is now in the background.
    await this.cancelBackgroundDwells(tabId);

    const url = await this.tab.getActiveTabUrl(tabId);
    if (!url) {
      // Already replaced by a later activation.
      await this.cancelDwell(tabId);
      return;
    }

    await this.startDwell(tabId, url);
  }

  /** Called from chrome.tabs.onUpdated with the updated tab's status and url. */
  async onTabUpdated(tabId: number, status: string, url: string): Promise<void> {
    if (status !== "complete") {
      return; // Only act when the page has finished loading.
    }

    // A navigation on the same tab resets any existing dwell.
    await this.cancelDwell(tabId);

    // Pages that finish loading in a background tab were never viewed.
    if ((await this.tab.getActiveTabUrl(tabId)) !== url) {
      return;
    }

    await this.startDwell(tabId, url);
  }

  /** Called from chrome.tabs.onRemoved. */
  async onTabRemoved(tabId: number): Promise<void> {
    await this.cancelDwell(tabId);
  }

  // -------------------------------------------------------------------------
  // Dwell management
  // -------------------------------------------------------------------------

  /** Start a dwell timer for a tab. No-op if auto-save is disabled or the URL is not allowlisted. */
  async startDwell(tabId: number, url: string): Promise<void> {
    if (!(await this.enabled.isEnabled())) {
      return; // Auto-save is opt-in; off by default.
    }
    if (!isAllowlisted(url)) {
      return;
    }

    // Always cancel any existing alarm for this tab before creating a new one.
    await this.alarm.clear(alarmName(tabId));

    const startedAt = Date.now();
    await this.session.set(alarmName(tabId), { url, startedAt });
    await this.alarm.create(alarmName(tabId), startedAt + this.dwellMs);
  }

  /** Cancel a dwell timer and remove its session state. */
  async cancelDwell(tabId: number): Promise<void> {
    await this.alarm.clear(alarmName(tabId));
    await this.session.remove(alarmName(tabId));
  }

  /**
   * Cancel the dwell of every tab other than `exceptTabId` that is no longer in
   * front. Dwells in other windows stay. Pending dwells are read from the
   * scheduled alarms, so this also holds after a worker restart.
   */
  private async cancelBackgroundDwells(exceptTabId: number): Promise<void> {
    const names = await this.alarm.getAllNames();
    for (const name of names) {
      const tabId = parseAlarmTabId(name);
      if (tabId === null || tabId === exceptTabId) {
        continue;
      }
      if ((await this.tab.getActiveTabUrl(tabId)) === null) {
        await this.cancelDwell(tabId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Alarm handler
  // -------------------------------------------------------------------------

  /**
   * Called from chrome.alarms.onAlarm. Performs full re-verification before
   * triggering the capture pipeline.
   */
  async onAlarmFired(name: string): Promise<void> {
    const tabId = parseAlarmTabId(name);
    if (tabId === null) {
      return; // Not one of ours.
    }

    // Load session state (may be absent if the worker was restarted with no storage).
    const entry = await this.session.get(alarmName(tabId));
    if (!isDwellEntry(entry)) {
      return;
    }

    // Re-verify: the tab must still be in front (active in its window) on the
    // exact same allowlisted URL.
    const currentUrl = await this.tab.getActiveTabUrl(tabId);
    if (currentUrl !== entry.url) {
      await this.session.remove(alarmName(tabId));
      return;
    }

    if (!isAllowlisted(currentUrl)) {
      await this.session.remove(alarmName(tabId));
      return;
    }

    // Any non-failed record already represents this capture. Pending work and
    // local-only pages must not be duplicated by a later alarm.
    const { urlHash } = await normalizeUrl(entry.url);
    const existing = await this.dedupe.getByUrlHash(urlHash);
    if (existing && existing.status !== "failed") {
      await this.session.remove(alarmName(tabId));
      return;
    }

    // All checks passed — run the capture pipeline.
    // try/finally guarantees session cleanup even if saveAuto throws.
    try {
      await this.capture.saveAuto(tabId);
    } finally {
      await this.session.remove(alarmName(tabId));
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome-backed production port implementations
// ---------------------------------------------------------------------------

/**
 * Production AlarmPort backed by chrome.alarms.
 * Register listeners at top level in the worker — NOT inside this class.
 */
export const chromeAlarmPort: AlarmPort = {
  async create(name, when) {
    return new Promise((resolve) => {
      chrome.alarms.create(name, { when });
      resolve();
    });
  },
  async clear(name) {
    return chrome.alarms.clear(name);
  },
  async getAllNames() {
    const alarms = await chrome.alarms.getAll();
    return alarms.map((alarm) => alarm.name);
  },
};

/**
 * Production SessionStoragePort backed by chrome.storage.session.
 */
export const chromeSessionPort: SessionStoragePort = {
  async get(key) {
    const result = await chrome.storage.session.get(key);
    return result[key];
  },
  async set(key, value) {
    await chrome.storage.session.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.session.remove(key);
  },
};

/**
 * Production TabQueryPort backed by chrome.tabs.
 */
export const chromeTabPort: TabQueryPort = {
  async getActiveTabUrl(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.active && tab.url ? tab.url : null;
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function alarmName(tabId: number): string {
  return `${ALARM_PREFIX}${tabId}`;
}

/** Returns the tab id encoded in an auto-save alarm name, or null for other alarms. */
function parseAlarmTabId(name: string): number | null {
  if (!name.startsWith(ALARM_PREFIX)) {
    return null;
  }
  const tabId = parseInt(name.slice(ALARM_PREFIX.length), 10);
  return isNaN(tabId) ? null : tabId;
}
