# M2 Manual Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build M2 manual capture so the popup saves the active page into IndexedDB and the side panel library lists saved pages.

**Architecture:** M2 introduces the durable capture path without LLM work. A lightweight content script extracts title, URL, readable text, and dwell time on request; the service worker stores the result through a Dexie repository; UI surfaces communicate only through typed worker messages.

**Tech Stack:** TypeScript strict mode, React 18, Vite, CRXJS MV3, Dexie, @mozilla/readability, fake-indexeddb, Vitest, Testing Library.

---

## Scope

M2 implements only manual capture:

- Popup "Save this page" sends `page.save` for the active tab.
- Worker requests extraction from the page and persists a `PageRecord`.
- IndexedDB row contains title, normalized URL, URL hash, domain, fullText, timestamps, and M2-safe defaults for fields that M3 will fill later.
- Side panel empty-query library view lists saved pages newest first.
- No OpenAI API key checks, no summaries, no tags, no embeddings, no chunking, no search.

Baseline in this worktree before plan creation:

- `pnpm install` completed.
- `pnpm test` passed: 5 files, 8 tests.
- `pnpm typecheck` passed.

## File Structure

- Modify `package.json` and `pnpm-lock.yaml` for runtime capture/storage dependencies.
- Modify `src/test/setup.ts` to install fake IndexedDB during Vitest.
- Create `src/shared/types.ts` for M2 domain records and page-list DTOs.
- Modify `src/shared/messages.ts` for `page.save`, `page.list`, and content extraction message contracts.
- Create `src/lib/urlNormalize.ts` and `src/lib/urlNormalize.test.ts` for canonical URL plus SHA-256 URL hash.
- Create `src/worker/repository/db.ts`, `src/worker/repository/PageRepo.ts`, and `src/worker/repository/PageRepo.test.ts` for Dexie persistence.
- Create `src/content/extract.ts` and `src/content/extract.test.ts` for readable page extraction and the content-script message listener.
- Modify `manifest.config.ts` to register the inert content script on HTTP(S) pages.
- Create `src/worker/services/CaptureService.ts` and `src/worker/services/CaptureService.test.ts` for save orchestration.
- Modify `src/worker/index.ts` and `src/worker/index.test.ts` for typed worker dispatch.
- Modify `src/popup/Popup.tsx` and `src/popup/Popup.test.tsx` for save behavior.
- Create `src/ui/components/PageCard.tsx`; modify `src/ui/components/index.ts`.
- Modify `src/sidepanel/App.tsx` and `src/sidepanel/App.test.tsx` for library listing.

## Task 1: Install Capture And Storage Dependencies

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/test/setup.ts`

- [ ] **Step 1: Install dependencies**

Run:

```bash
pnpm add dexie @mozilla/readability ulid
pnpm add -D fake-indexeddb
```

Expected: `package.json` gains `dexie`, `@mozilla/readability`, and `ulid` under `dependencies`, and `fake-indexeddb` under `devDependencies`.

- [ ] **Step 2: Add fake IndexedDB test setup**

Replace `src/test/setup.ts` with:

```ts
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Verify the setup still passes**

Run:

```bash
pnpm test
```

Expected: PASS with the existing 5 test files.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/test/setup.ts
git commit -m "chore: add m2 capture dependencies"
```

## Task 2: Define M2 Domain Types And URL Normalization

**Files:**
- Create: `src/shared/types.ts`
- Modify: `src/shared/messages.ts`
- Create: `src/lib/urlNormalize.test.ts`
- Create: `src/lib/urlNormalize.ts`

- [ ] **Step 1: Write failing URL normalization tests**

Create `src/lib/urlNormalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { normalizeUrl } from "./urlNormalize";

describe("normalizeUrl", () => {
  it("removes fragments and tracking query params before hashing", async () => {
    const result = await normalizeUrl(
      "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API?utm_source=demo&foo=bar#greeting",
    );

    expect(result.url).toBe(
      "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API?foo=bar",
    );
    expect(result.domain).toBe("developer.mozilla.org");
    expect(result.urlHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sorts remaining query params so equivalent URLs dedupe", async () => {
    const first = await normalizeUrl("https://react.dev/reference?a=1&b=2");
    const second = await normalizeUrl("https://react.dev/reference?b=2&a=1");

    expect(first.url).toBe("https://react.dev/reference?a=1&b=2");
    expect(second.url).toBe(first.url);
    expect(second.urlHash).toBe(first.urlHash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test src/lib/urlNormalize.test.ts
```

Expected: FAIL with `Failed to resolve import "./urlNormalize"`.

- [ ] **Step 3: Add shared types**

Create `src/shared/types.ts`:

```ts
export type SourceType =
  | "official_docs"
  | "github_issue"
  | "stackoverflow"
  | "blog"
  | "paper"
  | "course_material"
  | "unknown";

export type Intent =
  | "learning"
  | "debugging"
  | "reference"
  | "implementation"
  | "comparison";

export type SaveMode = "manual" | "auto";

export type PageStatus = "pending" | "ready" | "failed";

export type PageRecord = {
  id: string;
  url: string;
  urlHash: string;
  title: string;
  domain: string;
  sourceType: SourceType;
  summary: string;
  topics: string[];
  technologies: string[];
  intent: Intent;
  fullText: string;
  savedAt: number;
  visitedAt: number;
  readingTimeMs: number;
  saveMode: SaveMode;
  status: PageStatus;
  errorReason?: string;
  schemaVersion: 1;
};

export type PageListItem = Pick<
  PageRecord,
  | "id"
  | "url"
  | "title"
  | "domain"
  | "sourceType"
  | "summary"
  | "topics"
  | "technologies"
  | "savedAt"
  | "status"
>;

export type ExtractedPage = {
  url: string;
  title: string;
  fullText: string;
  readingTimeMs: number;
};

export type PageCaptureInput = ExtractedPage & {
  saveMode: SaveMode;
};
```

- [ ] **Step 4: Add URL normalization implementation**

Create `src/lib/urlNormalize.ts`:

```ts
const TRACKING_PARAMS = new Set(["gclid", "fbclid"]);

export type NormalizedUrl = {
  url: string;
  urlHash: string;
  domain: string;
};

export async function normalizeUrl(rawUrl: string): Promise<NormalizedUrl> {
  const parsed = new URL(rawUrl);
  parsed.hash = "";

  for (const key of Array.from(parsed.searchParams.keys())) {
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) {
      parsed.searchParams.delete(key);
    }
  }

  parsed.searchParams.sort();

  const normalized = parsed.toString();

  return {
    url: normalized,
    urlHash: await sha256Hex(normalized),
    domain: parsed.hostname,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 5: Extend typed message contracts**

Replace `src/shared/messages.ts` with:

```ts
import type { ExtractedPage, PageListItem } from "./types";

export const APP_NAME = "DevRecall";
export const APP_VERSION = "0.1.0";

export type PersistentStorageState = "unknown" | "granted" | "denied";

export type DevRecallRequest =
  | { type: "devrecall.ping" }
  | { type: "settings.getStatus" }
  | { type: "page.save"; payload: { tabId: number } }
  | { type: "page.list"; payload: { limit: number } };

export type DevRecallResponse =
  | {
      type: "devrecall.pong";
      payload: {
        appName: typeof APP_NAME;
        version: typeof APP_VERSION;
      };
    }
  | {
      type: "settings.status";
      payload: {
        hasApiKey: boolean;
        persistentStorage: PersistentStorageState;
      };
    }
  | {
      type: "page.saved";
      payload: {
        page: PageListItem;
      };
    }
  | {
      type: "page.listed";
      payload: {
        pages: PageListItem[];
      };
    };

export type ContentExtractRequest = { type: "content.extract" };

export type ContentExtractResponse =
  | {
      type: "content.extracted";
      payload: ExtractedPage;
    }
  | {
      type: "content.extractFailed";
      payload: {
        message: string;
      };
    };
```

- [ ] **Step 6: Verify tests pass**

Run:

```bash
pnpm test src/lib/urlNormalize.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/messages.ts src/lib/urlNormalize.ts src/lib/urlNormalize.test.ts
git commit -m "feat: add m2 page types and url normalization"
```

## Task 3: Add Dexie Page Repository

**Files:**
- Create: `src/worker/repository/db.ts`
- Create: `src/worker/repository/PageRepo.test.ts`
- Create: `src/worker/repository/PageRepo.ts`

- [ ] **Step 1: Write failing repository tests**

Create `src/worker/repository/PageRepo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { DevRecallDatabase } from "./db";
import { PageRepo } from "./PageRepo";

describe("PageRepo", () => {
  let database: DevRecallDatabase;
  let repo: PageRepo;

  beforeEach(async () => {
    database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    repo = new PageRepo(database);
    await database.delete();
    await database.open();
  });

  it("stores a manually captured page with M2 defaults", async () => {
    const page = await repo.upsertCapturedPage({
      url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/?utm_source=demo#walkthrough",
      title: "Horizontal Pod Autoscaling",
      fullText: "The HorizontalPodAutoscaler automatically updates workload resources.",
      readingTimeMs: 42_000,
      saveMode: "manual",
    });

    expect(page).toMatchObject({
      url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      title: "Horizontal Pod Autoscaling",
      domain: "kubernetes.io",
      sourceType: "unknown",
      summary: "",
      topics: [],
      technologies: [],
      intent: "reference",
      fullText:
        "The HorizontalPodAutoscaler automatically updates workload resources.",
      readingTimeMs: 42_000,
      saveMode: "manual",
      status: "ready",
      schemaVersion: 1,
    });
    expect(page.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(page.urlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.savedAt).toBeGreaterThan(0);
    expect(page.visitedAt).toBeGreaterThanOrEqual(page.savedAt);
  });

  it("updates an existing URL in place instead of creating duplicates", async () => {
    const first = await repo.upsertCapturedPage({
      url: "https://react.dev/reference/react/useMemo?utm_campaign=first",
      title: "useMemo old title",
      fullText: "Old content",
      readingTimeMs: 1000,
      saveMode: "manual",
    });

    const second = await repo.upsertCapturedPage({
      url: "https://react.dev/reference/react/useMemo",
      title: "useMemo",
      fullText: "New content",
      readingTimeMs: 2000,
      saveMode: "manual",
    });

    const pages = await repo.listPages({ limit: 10 });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("useMemo");
    expect(second.fullText).toBe("New content");
    expect(second.savedAt).toBe(first.savedAt);
    expect(second.visitedAt).toBeGreaterThanOrEqual(first.visitedAt);
    expect(pages).toHaveLength(1);
  });

  it("lists pages newest first without fullText", async () => {
    await repo.upsertCapturedPage({
      url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API",
      title: "IndexedDB API",
      fullText: "IndexedDB stores structured data.",
      readingTimeMs: 3000,
      saveMode: "manual",
    });

    await repo.upsertCapturedPage({
      url: "https://stackoverflow.com/questions/1/example",
      title: "Example Stack Overflow answer",
      fullText: "A useful debugging note.",
      readingTimeMs: 4000,
      saveMode: "manual",
    });

    const pages = await repo.listPages({ limit: 10 });

    expect(pages.map((page) => page.title)).toEqual([
      "Example Stack Overflow answer",
      "IndexedDB API",
    ]);
    expect(pages[0]).not.toHaveProperty("fullText");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test src/worker/repository/PageRepo.test.ts
```

Expected: FAIL with `Failed to resolve import "./db"`.

- [ ] **Step 3: Add Dexie database**

Create `src/worker/repository/db.ts`:

```ts
import Dexie, { type Table } from "dexie";

import type { PageRecord } from "../../shared/types";

export class DevRecallDatabase extends Dexie {
  pages!: Table<PageRecord, string>;

  constructor(name = "devrecall") {
    super(name);

    this.version(1).stores({
      pages: "&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]",
    });
  }
}

export const db = new DevRecallDatabase();
```

- [ ] **Step 4: Add PageRepo implementation**

Create `src/worker/repository/PageRepo.ts`:

```ts
import { ulid } from "ulid";

import { normalizeUrl } from "../../lib/urlNormalize";
import type { PageCaptureInput, PageListItem, PageRecord } from "../../shared/types";
import { db, type DevRecallDatabase } from "./db";

export class PageRepo {
  constructor(private readonly database: DevRecallDatabase = db) {}

  async upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord> {
    const normalized = await normalizeUrl(input.url);
    const existing = await this.database.pages
      .where("urlHash")
      .equals(normalized.urlHash)
      .first();
    const now = Date.now();

    const page: PageRecord = {
      id: existing?.id ?? ulid(),
      url: normalized.url,
      urlHash: normalized.urlHash,
      title: input.title,
      domain: normalized.domain,
      sourceType: "unknown",
      summary: "",
      topics: [],
      technologies: [],
      intent: "reference",
      fullText: input.fullText,
      savedAt: existing?.savedAt ?? now,
      visitedAt: now,
      readingTimeMs: input.readingTimeMs,
      saveMode: input.saveMode,
      status: "ready",
      schemaVersion: 1,
    };

    await this.database.pages.put(page);

    return page;
  }

  async listPages({ limit }: { limit: number }): Promise<PageListItem[]> {
    const pages = await this.database.pages
      .orderBy("savedAt")
      .reverse()
      .limit(limit)
      .toArray();

    return pages.map(toPageListItem);
  }
}

export function toPageListItem(page: PageRecord): PageListItem {
  return {
    id: page.id,
    url: page.url,
    title: page.title,
    domain: page.domain,
    sourceType: page.sourceType,
    summary: page.summary,
    topics: page.topics,
    technologies: page.technologies,
    savedAt: page.savedAt,
    status: page.status,
  };
}
```

- [ ] **Step 5: Verify repository tests pass**

Run:

```bash
pnpm test src/worker/repository/PageRepo.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/repository/db.ts src/worker/repository/PageRepo.ts src/worker/repository/PageRepo.test.ts
git commit -m "feat: persist captured pages"
```

## Task 4: Add Content Extraction

**Files:**
- Create: `src/content/extract.test.ts`
- Create: `src/content/extract.ts`
- Modify: `manifest.config.ts`

M2 uses a registered, inert content script because CRXJS reliably bundles manifest-declared content scripts. The script stays stateless and only extracts when the worker sends `content.extract`.

- [ ] **Step 1: Write failing extraction tests**

Create `src/content/extract.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { extractPage } from "./extract";

describe("extractPage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    window.history.pushState({}, "", "https://example.com/docs?utm_source=test#top");
  });

  it("extracts title url fullText and reading time", () => {
    document.title = "Useful Docs";
    document.body.innerHTML = `
      <article>
        <h1>Useful Docs</h1>
        <p>This page explains an implementation detail.</p>
      </article>
    `;

    const result = extractPage(document, () => 1234.4);

    expect(result).toEqual({
      url: "https://example.com/docs?utm_source=test#top",
      title: "Useful Docs",
      fullText: "Useful Docs This page explains an implementation detail.",
      readingTimeMs: 1234,
    });
  });

  it("throws when no readable text exists", () => {
    document.body.innerHTML = "<main></main>";

    expect(() => extractPage(document, () => 1)).toThrow(
      "No readable page text found",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test src/content/extract.test.ts
```

Expected: FAIL with `Failed to resolve import "./extract"`.

- [ ] **Step 3: Add extraction implementation and listener**

Create `src/content/extract.ts`:

```ts
import { Readability } from "@mozilla/readability";

import type {
  ContentExtractRequest,
  ContentExtractResponse,
} from "../shared/messages";
import type { ExtractedPage } from "../shared/types";

export function extractPage(
  doc: Document = document,
  clock: () => number = () => performance.now(),
): ExtractedPage {
  const article = new Readability(doc.cloneNode(true) as Document).parse();
  const fallbackText = doc.body?.innerText ?? doc.body?.textContent ?? "";
  const fullText = collapseWhitespace(article?.textContent ?? fallbackText);

  if (fullText.length === 0) {
    throw new Error("No readable page text found");
  }

  return {
    url: doc.location.href,
    title: article?.title?.trim() || doc.title.trim() || "Untitled page",
    fullText,
    readingTimeMs: Math.round(clock()),
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (
      request: ContentExtractRequest,
      _sender,
      sendResponse: (response: ContentExtractResponse) => void,
    ) => {
      if (request.type !== "content.extract") {
        return false;
      }

      try {
        sendResponse({
          type: "content.extracted",
          payload: extractPage(),
        });
      } catch (error) {
        sendResponse({
          type: "content.extractFailed",
          payload: {
            message:
              error instanceof Error ? error.message : "Unknown extraction error",
          },
        });
      }

      return true;
    },
  );
}
```

- [ ] **Step 4: Register content script in the manifest**

Modify `manifest.config.ts` so the exported manifest includes `content_scripts`:

```ts
import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "DevRecall",
  description: "Local-first recall for technical browsing sessions.",
  version: "0.1.0",
  action: {
    default_title: "DevRecall",
    default_popup: "src/popup/index.html",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/worker/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["src/content/extract.ts"],
      run_at: "document_idle",
    },
  ],
  permissions: ["activeTab", "sidePanel", "scripting", "storage", "tabs"],
  host_permissions: ["http://*/*", "https://*/*"],
});
```

- [ ] **Step 5: Verify extraction and build**

Run:

```bash
pnpm test src/content/extract.test.ts
pnpm typecheck
pnpm build
```

Expected: PASS. `pnpm build` should produce `dist/` without manifest or content-script errors.

- [ ] **Step 6: Commit**

```bash
git add manifest.config.ts src/content/extract.ts src/content/extract.test.ts
git commit -m "feat: extract readable page content"
```

## Task 5: Add CaptureService And Worker Messages

**Files:**
- Create: `src/worker/services/CaptureService.test.ts`
- Create: `src/worker/services/CaptureService.ts`
- Modify: `src/worker/index.test.ts`
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Write failing CaptureService tests**

Create `src/worker/services/CaptureService.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { ExtractedPage, PageRecord } from "../../shared/types";
import { CaptureService, type PageExtractor, type PageWriter } from "./CaptureService";

describe("CaptureService", () => {
  it("extracts the tab and stores a manual page", async () => {
    const extracted: ExtractedPage = {
      url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      title: "Horizontal Pod Autoscaling",
      fullText: "Autoscaling docs",
      readingTimeMs: 30_000,
    };
    const page = {
      id: "01HZ0000000000000000000000",
      url: extracted.url,
      urlHash: "a".repeat(64),
      title: extracted.title,
      domain: "kubernetes.io",
      sourceType: "unknown",
      summary: "",
      topics: [],
      technologies: [],
      intent: "reference",
      fullText: extracted.fullText,
      savedAt: 1,
      visitedAt: 1,
      readingTimeMs: extracted.readingTimeMs,
      saveMode: "manual",
      status: "ready",
      schemaVersion: 1,
    } satisfies PageRecord;
    const extractor: PageExtractor = {
      extract: vi.fn().mockResolvedValue(extracted),
    };
    const writer: PageWriter = {
      upsertCapturedPage: vi.fn().mockResolvedValue(page),
    };

    const result = await new CaptureService(writer, extractor).save(123);

    expect(extractor.extract).toHaveBeenCalledWith(123);
    expect(writer.upsertCapturedPage).toHaveBeenCalledWith({
      ...extracted,
      saveMode: "manual",
    });
    expect(result).toBe(page);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test src/worker/services/CaptureService.test.ts
```

Expected: FAIL with `Failed to resolve import "./CaptureService"`.

- [ ] **Step 3: Add CaptureService implementation**

Create `src/worker/services/CaptureService.ts`:

```ts
import type {
  ContentExtractRequest,
  ContentExtractResponse,
} from "../../shared/messages";
import type { ExtractedPage, PageCaptureInput, PageRecord } from "../../shared/types";
import { PageRepo } from "../repository/PageRepo";

export type PageExtractor = {
  extract(tabId: number): Promise<ExtractedPage>;
};

export type PageWriter = {
  upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord>;
};

export class ChromePageExtractor implements PageExtractor {
  async extract(tabId: number): Promise<ExtractedPage> {
    if (typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
      throw new Error("Chrome tabs messaging is unavailable");
    }

    const request: ContentExtractRequest = { type: "content.extract" };
    const response = (await chrome.tabs.sendMessage(
      tabId,
      request,
    )) as ContentExtractResponse;

    if (response.type === "content.extractFailed") {
      throw new Error(response.payload.message);
    }

    return response.payload;
  }
}

export class CaptureService {
  constructor(
    private readonly pages: PageWriter = new PageRepo(),
    private readonly extractor: PageExtractor = new ChromePageExtractor(),
  ) {}

  async save(tabId: number): Promise<PageRecord> {
    const extracted = await this.extractor.extract(tabId);

    return this.pages.upsertCapturedPage({
      ...extracted,
      saveMode: "manual",
    });
  }
}
```

- [ ] **Step 4: Extend worker dispatch tests**

Replace `src/worker/index.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";

import { APP_NAME, APP_VERSION } from "../shared/messages";
import type { PageListItem, PageRecord } from "../shared/types";
import { handleRequest } from "./index";

const pageRecord = {
  id: "01HZ0000000000000000000000",
  url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API",
  urlHash: "a".repeat(64),
  title: "IndexedDB API",
  domain: "developer.mozilla.org",
  sourceType: "unknown",
  summary: "",
  topics: [],
  technologies: [],
  intent: "reference",
  fullText: "IndexedDB stores structured data.",
  savedAt: 100,
  visitedAt: 100,
  readingTimeMs: 2000,
  saveMode: "manual",
  status: "ready",
  schemaVersion: 1,
} satisfies PageRecord;

const pageListItem = {
  id: pageRecord.id,
  url: pageRecord.url,
  title: pageRecord.title,
  domain: pageRecord.domain,
  sourceType: pageRecord.sourceType,
  summary: pageRecord.summary,
  topics: pageRecord.topics,
  technologies: pageRecord.technologies,
  savedAt: pageRecord.savedAt,
  status: pageRecord.status,
} satisfies PageListItem;

describe("worker request handler", () => {
  it("responds to a ping request", async () => {
    await expect(handleRequest({ type: "devrecall.ping" })).resolves.toEqual({
      type: "devrecall.pong",
      payload: {
        appName: APP_NAME,
        version: APP_VERSION,
      },
    });
  });

  it("returns the initial settings status", async () => {
    await expect(
      handleRequest({ type: "settings.getStatus" }),
    ).resolves.toEqual({
      type: "settings.status",
      payload: {
        hasApiKey: false,
        persistentStorage: "unknown",
      },
    });
  });

  it("saves the active tab through CaptureService", async () => {
    const captureService = {
      save: vi.fn().mockResolvedValue(pageRecord),
    };
    const pageRepo = {
      listPages: vi.fn(),
    };

    await expect(
      handleRequest(
        { type: "page.save", payload: { tabId: 7 } },
        { captureService, pageRepo },
      ),
    ).resolves.toEqual({
      type: "page.saved",
      payload: { page: pageListItem },
    });
    expect(captureService.save).toHaveBeenCalledWith(7);
  });

  it("lists saved pages through PageRepo", async () => {
    const captureService = {
      save: vi.fn(),
    };
    const pageRepo = {
      listPages: vi.fn().mockResolvedValue([pageListItem]),
    };

    await expect(
      handleRequest(
        { type: "page.list", payload: { limit: 25 } },
        { captureService, pageRepo },
      ),
    ).resolves.toEqual({
      type: "page.listed",
      payload: { pages: [pageListItem] },
    });
    expect(pageRepo.listPages).toHaveBeenCalledWith({ limit: 25 });
  });
});
```

- [ ] **Step 5: Run worker tests to verify dispatch fails**

Run:

```bash
pnpm test src/worker/index.test.ts
```

Expected: FAIL because `handleRequest` does not accept injected dependencies and does not handle `page.save` or `page.list`.

- [ ] **Step 6: Update worker dispatch**

Replace `src/worker/index.ts` with:

```ts
import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
} from "../shared/messages";
import type { PageListItem, PageRecord } from "../shared/types";
import { PageRepo } from "./repository/PageRepo";
import { CaptureService } from "./services/CaptureService";

type CapturePort = {
  save(tabId: number): Promise<PageRecord>;
};

type PageListPort = {
  listPages(input: { limit: number }): Promise<PageListItem[]>;
};

type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
};

const pageRepo = new PageRepo();
const defaultDeps: HandlerDeps = {
  captureService: new CaptureService(pageRepo),
  pageRepo,
};

export async function handleRequest(
  request: DevRecallRequest,
  deps: HandlerDeps = defaultDeps,
): Promise<DevRecallResponse> {
  switch (request.type) {
    case "devrecall.ping":
      return {
        type: "devrecall.pong",
        payload: {
          appName: APP_NAME,
          version: APP_VERSION,
        },
      };

    case "settings.getStatus":
      return {
        type: "settings.status",
        payload: {
          hasApiKey: false,
          persistentStorage: "unknown",
        },
      };

    case "page.save":
      return {
        type: "page.saved",
        payload: {
          page: toPageListItem(await deps.captureService.save(request.payload.tabId)),
        },
      };

    case "page.list":
      return {
        type: "page.listed",
        payload: {
          pages: await deps.pageRepo.listPages({
            limit: request.payload.limit,
          }),
        },
      };
  }
}

function toPageListItem(page: PageRecord): PageListItem {
  return {
    id: page.id,
    url: page.url,
    title: page.title,
    domain: page.domain,
    sourceType: page.sourceType,
    summary: page.summary,
    topics: page.topics,
    technologies: page.technologies,
    savedAt: page.savedAt,
    status: page.status,
  };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    console.info("[DevRecall] installed");
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (
      request: DevRecallRequest,
      _sender,
      sendResponse: (response: DevRecallResponse) => void,
    ) => {
      void handleRequest(request).then(sendResponse);
      return true;
    },
  );
}
```

- [ ] **Step 7: Verify service and worker tests pass**

Run:

```bash
pnpm test src/worker/services/CaptureService.test.ts src/worker/index.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/worker/services/CaptureService.ts src/worker/services/CaptureService.test.ts src/worker/index.ts src/worker/index.test.ts
git commit -m "feat: add manual capture worker messages"
```

## Task 6: Wire Popup Save Behavior

**Files:**
- Modify: `src/popup/Popup.test.tsx`
- Modify: `src/popup/Popup.tsx`

- [ ] **Step 1: Replace popup tests with save-state coverage**

Replace `src/popup/Popup.test.tsx` with:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Popup } from "./Popup";

describe("Popup", () => {
  it("enables manual save without requiring an API key", () => {
    render(<Popup saveCurrentPage={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "DevRecall" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save this page" }),
    ).toBeEnabled();
    expect(screen.queryByText("Set API key in settings")).not.toBeInTheDocument();
  });

  it("saves the current page and shows a saved state", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockResolvedValue(undefined);

    render(<Popup saveCurrentPage={saveCurrentPage} />);

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(saveCurrentPage).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Saved" })).toBeEnabled();
  });

  it("shows an error state when save fails", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockRejectedValue(new Error("no tab"));

    render(<Popup saveCurrentPage={saveCurrentPage} />);

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(await screen.findByText("Failed to save page")).toBeInTheDocument();
  });

  it("opens the side panel through the injected callback", async () => {
    const user = userEvent.setup();
    const openSidePanel = vi.fn();

    render(<Popup openSidePanel={openSidePanel} saveCurrentPage={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Open library" }));

    expect(openSidePanel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run popup tests to verify they fail**

Run:

```bash
pnpm test src/popup/Popup.test.tsx
```

Expected: FAIL because the save button is still disabled and `Popup` does not accept `saveCurrentPage`.

- [ ] **Step 3: Implement popup save behavior**

Replace `src/popup/Popup.tsx` with:

```tsx
import { useState } from "react";

import type { DevRecallRequest } from "../shared/messages";
import { SurfaceShell } from "../ui/components";

type SaveState = "idle" | "saving" | "saved" | "failed";

type PopupProps = {
  openSidePanel?: () => void;
  saveCurrentPage?: () => Promise<void>;
};

function defaultOpenSidePanel() {
  if (typeof chrome === "undefined" || !chrome.sidePanel?.open) {
    return;
  }

  void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
}

async function defaultSaveCurrentPage() {
  if (
    typeof chrome === "undefined" ||
    !chrome.tabs?.query ||
    !chrome.runtime?.sendMessage
  ) {
    throw new Error("Chrome extension APIs are unavailable");
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (typeof tab?.id !== "number") {
    throw new Error("No active tab is available");
  }

  const request: DevRecallRequest = {
    type: "page.save",
    payload: { tabId: tab.id },
  };

  await chrome.runtime.sendMessage(request);
}

export function Popup({
  openSidePanel = defaultOpenSidePanel,
  saveCurrentPage = defaultSaveCurrentPage,
}: PopupProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");

  async function handleSave() {
    setSaveState("saving");

    try {
      await saveCurrentPage();
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  }

  return (
    <SurfaceShell title="DevRecall">
      <div className="flex min-h-[180px] flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-slate-900">Current page</p>
          <p className="mt-1 truncate text-sm text-slate-500">
            Ready to save into your library
          </p>
        </div>

        <button
          type="button"
          disabled={saveState === "saving"}
          onClick={handleSave}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300 disabled:text-slate-600"
        >
          {saveState === "saving"
            ? "Saving..."
            : saveState === "saved"
              ? "Saved"
              : "Save this page"}
        </button>

        {saveState === "failed" ? (
          <p className="text-xs text-red-600">Failed to save page</p>
        ) : (
          <p className="text-xs text-slate-500">
            Manual capture stores title, URL, and readable text.
          </p>
        )}

        <button
          type="button"
          onClick={openSidePanel}
          className="mt-auto w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
        >
          Open library
        </button>
      </div>
    </SurfaceShell>
  );
}
```

- [ ] **Step 4: Verify popup tests pass**

Run:

```bash
pnpm test src/popup/Popup.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/popup/Popup.tsx src/popup/Popup.test.tsx
git commit -m "feat: save pages from popup"
```

## Task 7: Wire Side Panel Library Listing

**Files:**
- Create: `src/ui/components/PageCard.tsx`
- Modify: `src/ui/components/index.ts`
- Modify: `src/sidepanel/App.test.tsx`
- Modify: `src/sidepanel/App.tsx`

- [ ] **Step 1: Replace side panel tests with library coverage**

Replace `src/sidepanel/App.test.tsx` with:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PageListItem } from "../shared/types";
import { App } from "./App";

const pages = [
  {
    id: "01HZ0000000000000000000000",
    url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
    title: "Horizontal Pod Autoscaling",
    domain: "kubernetes.io",
    sourceType: "unknown",
    summary: "",
    topics: [],
    technologies: [],
    savedAt: 100,
    status: "ready",
  },
] satisfies PageListItem[];

describe("Side panel app", () => {
  it("renders the library search shell", async () => {
    render(<App listPages={vi.fn().mockResolvedValue([])} />);

    expect(
      screen.getByRole("heading", { name: "DevRecall" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search saved pages" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("No saved pages yet")).toBeInTheDocument();
  });

  it("lists saved pages from the worker", async () => {
    const listPages = vi.fn().mockResolvedValue(pages);

    render(<App listPages={listPages} />);

    expect(listPages).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", {
        name: "Horizontal Pod Autoscaling",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("kubernetes.io")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run side panel tests to verify they fail**

Run:

```bash
pnpm test src/sidepanel/App.test.tsx
```

Expected: FAIL because `App` does not accept `listPages` and does not render saved pages.

- [ ] **Step 3: Add PageCard component**

Create `src/ui/components/PageCard.tsx`:

```tsx
import type { PageListItem } from "../../shared/types";

type PageCardProps = {
  page: PageListItem;
};

export function PageCard({ page }: PageCardProps) {
  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-3">
      <h2 className="text-sm font-semibold text-slate-900">{page.title}</h2>
      <p className="mt-1 text-xs text-slate-500">{page.domain}</p>
      <p className="mt-2 line-clamp-2 text-sm text-slate-600">
        {page.summary || page.url}
      </p>
    </article>
  );
}
```

Modify `src/ui/components/index.ts`:

```ts
export { PageCard } from "./PageCard";
export { SurfaceShell } from "./SurfaceShell";
```

- [ ] **Step 4: Implement side panel library loading**

Replace `src/sidepanel/App.tsx` with:

```tsx
import { useEffect, useState } from "react";

import type { DevRecallRequest, DevRecallResponse } from "../shared/messages";
import type { PageListItem } from "../shared/types";
import { PageCard, SurfaceShell } from "../ui/components";

const filters = ["All", "Docs", "SO", "GH"] as const;

type AppProps = {
  listPages?: () => Promise<PageListItem[]>;
};

async function defaultListPages(): Promise<PageListItem[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }

  const request: DevRecallRequest = {
    type: "page.list",
    payload: { limit: 50 },
  };
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as DevRecallResponse;

  if (response.type !== "page.listed") {
    return [];
  }

  return response.payload.pages;
}

export function App({ listPages = defaultListPages }: AppProps) {
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadPages() {
      setLoading(true);
      const nextPages = await listPages();

      if (!cancelled) {
        setPages(nextPages);
        setLoading(false);
      }
    }

    void loadPages();

    return () => {
      cancelled = true;
    };
  }, [listPages]);

  return (
    <SurfaceShell
      title="DevRecall"
      actions={
        <button
          type="button"
          aria-label="Settings"
          className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600"
        >
          Settings
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <input
          type="search"
          aria-label="Search saved pages"
          placeholder="Search saved pages"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <div className="flex gap-2">
          {filters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filter === "All"}
              className="rounded-md border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 aria-pressed:border-accent aria-pressed:text-accent"
            >
              {filter}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-slate-500">Loading library...</p>
        ) : pages.length === 0 ? (
          <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
            <h2 className="text-sm font-semibold text-slate-900">
              No saved pages yet
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              Saved pages will appear here.
            </p>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {pages.map((page) => (
              <PageCard key={page.id} page={page} />
            ))}
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}
```

- [ ] **Step 5: Verify side panel tests pass**

Run:

```bash
pnpm test src/sidepanel/App.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/PageCard.tsx src/ui/components/index.ts src/sidepanel/App.tsx src/sidepanel/App.test.tsx
git commit -m "feat: list saved pages in side panel"
```

## Task 8: Final M2 Verification

**Files:**
- Review all files changed in Tasks 1-7.

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all commands pass.

- [ ] **Step 2: Manually smoke test the extension build**

Run:

```bash
pnpm dev
```

Then load the extension from `dist/` in Chrome:

1. Open an HTTP(S) documentation page.
2. Click the DevRecall toolbar icon.
3. Click `Save this page`.
4. Open the side panel.
5. Confirm the saved page title and domain appear in the library.
6. Click Save again on the same URL.
7. Confirm the side panel still shows one row for that URL.

Expected: manual save creates or updates one IndexedDB page row and the side panel lists it.

- [ ] **Step 3: Check M2 scope boundaries**

Run:

```bash
rg -n "OpenAI|embedding|chunk|summary|apiKey|settings.setApiKey" src
```

Expected: no new M2 implementation depends on OpenAI, embeddings, chunking, generated summaries, or API key setup. Existing M1 settings skeleton references are acceptable only in `settings.getStatus` and options skeleton files.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only M2 plan files and M2 implementation files are changed.

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "feat: complete manual capture milestone"
```

## Self-Review Notes

- Spec coverage: M2 requires popup manual save, IndexedDB row with title, URL, fullText, and side panel library listing. Tasks 3, 5, 6, and 7 cover those requirements.
- Architecture coverage: UI talks through worker messages; worker owns DB writes; content extraction is stateless and runs only in response to `content.extract`.
- M2 boundaries: no LLM calls, no API key requirement, no summaries or tags generated, no retrieval or chunking.
- Type consistency: `PageRecord`, `PageListItem`, `ExtractedPage`, `PageCaptureInput`, `DevRecallRequest`, and `DevRecallResponse` are introduced once and reused consistently across repository, service, worker, popup, and side panel.
