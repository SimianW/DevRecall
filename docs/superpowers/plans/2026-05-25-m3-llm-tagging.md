# M3 LLM Tagging + Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build M3 so that saving a page enriches it with an LLM-generated summary, sourceType, topics, technologies, and intent via OpenAI, with pending/ready/failed status visible in the UI. The options page accepts and validates an API key.

**Architecture:** M3 converts M2's single-phase save (instant `"ready"`) into a two-phase pipeline: save as `"pending"` for instant UI feedback, then asynchronously call OpenAI `gpt-4o-mini` to enrich the record and set `"ready"` or `"failed"`. The API key lives in `chrome.storage.local`. The popup disables save when no key is set. OpenAI is called directly via `fetch` with exponential-backoff retry (no npm SDK).

**Tech Stack:** TypeScript strict mode, React 18, Vite, CRXJS MV3, Dexie, Vitest, Testing Library, OpenAI REST API via fetch.

---

## Scope

M3 implements LLM enrichment and API key management:

- Options page saves and tests an OpenAI API key via `chrome.storage.local`.
- Worker reads the API key from storage; `settings.getStatus` returns the real `hasApiKey` value.
- `PageRepo.upsertCapturedPage` stores pages as `"pending"` instead of `"ready"`.
- After save, the worker fires async LLM processing: calls `gpt-4o-mini` with the page text, parses the JSON response, and updates the page to `"ready"` with summary/tags. On failure, marks `"failed"` with `errorReason`.
- Popup checks `hasApiKey` on mount; disables save with an inline message when no key is set.
- PageCard shows pending (processing indicator) and failed (error text) status.
- No retry button (M6), no chunking, no embeddings, no search, no auto-save.

Baseline before plan creation:

- `pnpm install` completed.
- `pnpm test` passed: 8 test files.
- `pnpm typecheck` passed.

## File Structure

- Modify `src/shared/types.ts` for `TaggingResult`.
- Modify `src/shared/messages.ts` for `settings.setApiKey`, `settings.testConnection`, and their responses.
- Create `src/worker/settings/ApiKeyStore.ts` and `src/worker/settings/ApiKeyStore.test.ts` for `chrome.storage.local` key management.
- Create `src/worker/llm/OpenAIProvider.ts` and `src/worker/llm/OpenAIProvider.test.ts` for `PageTagger` interface, `OpenAIProvider`, and `testOpenAIConnection`.
- Modify `src/worker/repository/PageRepo.ts` and `src/worker/repository/PageRepo.test.ts` for pending default status, `getById`, and `updatePage`.
- Modify `src/worker/services/CaptureService.ts` and `src/worker/services/CaptureService.test.ts` for `processPage` two-phase enrichment.
- Modify `src/worker/index.ts` and `src/worker/index.test.ts` for new handlers and `ApiKeyStore`/`OpenAIProvider` wiring.
- Modify `src/options/Options.tsx` and `src/options/Options.test.tsx` for controlled API key input and test connection.
- Modify `src/ui/components/PageCard.tsx` for pending/failed status display.
- Modify `src/popup/Popup.tsx` and `src/popup/Popup.test.tsx` for API key gating.

## Task 1: Extend Shared Types And Message Contract

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Add TaggingResult type**

Append to `src/shared/types.ts` after the `PageCaptureInput` type:

```ts
export type TaggingResult = {
  summary: string;
  sourceType: SourceType;
  topics: string[];
  technologies: string[];
  intent: Intent;
};
```

- [ ] **Step 2: Extend message contract**

Replace `src/shared/messages.ts` with:

```ts
import type { ExtractedPage, PageListItem } from "./types";

export const APP_NAME = "DevRecall";
export const APP_VERSION = "0.1.0";

export type PersistentStorageState = "unknown" | "granted" | "denied";

export type DevRecallRequest =
  | { type: "devrecall.ping" }
  | { type: "settings.getStatus" }
  | { type: "settings.setApiKey"; payload: { apiKey: string } }
  | { type: "settings.testConnection" }
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
  | { type: "settings.apiKeySet" }
  | {
      type: "settings.connectionTestResult";
      payload: {
        success: boolean;
        message: string;
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

- [ ] **Step 3: Verify types compile**

Run:

```bash
pnpm typecheck
```

Expected: PASS. No existing code uses the new types yet, so nothing breaks.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/messages.ts
git commit -m "feat: add m3 tagging types and message contract"
```

## Task 2: Add API Key Storage

**Files:**
- Create: `src/worker/settings/ApiKeyStore.test.ts`
- Create: `src/worker/settings/ApiKeyStore.ts`

- [ ] **Step 1: Write failing API key store tests**

Create `src/worker/settings/ApiKeyStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChromeApiKeyStore } from "./ApiKeyStore";

describe("ChromeApiKeyStore", () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGet = vi.fn();
    mockSet = vi.fn().mockResolvedValue(undefined);
    globalThis.chrome = {
      storage: { local: { get: mockGet, set: mockSet } },
    } as unknown as typeof chrome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no API key is stored", async () => {
    mockGet.mockResolvedValue({});

    const store = new ChromeApiKeyStore();

    await expect(store.getApiKey()).resolves.toBeNull();
    expect(mockGet).toHaveBeenCalledWith("openai_api_key");
  });

  it("returns the stored API key", async () => {
    mockGet.mockResolvedValue({ openai_api_key: "sk-test123" });

    const store = new ChromeApiKeyStore();

    await expect(store.getApiKey()).resolves.toBe("sk-test123");
  });

  it("stores an API key", async () => {
    const store = new ChromeApiKeyStore();

    await store.setApiKey("sk-new");

    expect(mockSet).toHaveBeenCalledWith({ openai_api_key: "sk-new" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test src/worker/settings/ApiKeyStore.test.ts
```

Expected: FAIL with `Failed to resolve import "./ApiKeyStore"`.

- [ ] **Step 3: Add API key store implementation**

Create `src/worker/settings/ApiKeyStore.ts`:

```ts
export type ApiKeyStore = {
  getApiKey(): Promise<string | null>;
  setApiKey(apiKey: string): Promise<void>;
};

const STORAGE_KEY = "openai_api_key";

export class ChromeApiKeyStore implements ApiKeyStore {
  async getApiKey(): Promise<string | null> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return null;
    }

    const result = await chrome.storage.local.get(STORAGE_KEY);

    return (result[STORAGE_KEY] as string) ?? null;
  }

  async setApiKey(apiKey: string): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      throw new Error("Chrome storage is unavailable");
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: apiKey });
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm test src/worker/settings/ApiKeyStore.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/settings/ApiKeyStore.ts src/worker/settings/ApiKeyStore.test.ts
git commit -m "feat: add chrome.storage.local api key store"
```

## Task 3: Add OpenAI Provider

**Files:**
- Create: `src/worker/llm/OpenAIProvider.test.ts`
- Create: `src/worker/llm/OpenAIProvider.ts`

- [ ] **Step 1: Write failing OpenAI provider tests**

Create `src/worker/llm/OpenAIProvider.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaggingResult } from "../../shared/types";
import { OpenAIProvider, testOpenAIConnection } from "./OpenAIProvider";

const taggingResult: TaggingResult = {
  summary: "HPA autoscales pods based on CPU and memory metrics.",
  sourceType: "official_docs",
  topics: ["kubernetes", "autoscaling"],
  technologies: ["Kubernetes"],
  intent: "reference",
};

function mockFetchOk(result: TaggingResult) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: JSON.stringify(result) } }],
      }),
  });
}

describe("OpenAIProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a tagging request and parses the response", async () => {
    globalThis.fetch = mockFetchOk(taggingResult);
    const provider = new OpenAIProvider([]);

    const result = await provider.summarizeAndTag(
      "The HorizontalPodAutoscaler automatically updates workload resources.",
      "Horizontal Pod Autoscaling",
      "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      "sk-test123",
    );

    expect(result).toEqual(taggingResult);
    expect(fetch).toHaveBeenCalledOnce();

    const [url, options] = vi.mocked(fetch).mock.calls[0];

    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((options?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test123",
    );
  });

  it("throws on 401 without retrying", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401 });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-bad"),
    ).rejects.toThrow("Invalid API key");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify(taggingResult) } }],
          }),
      });
    const provider = new OpenAIProvider([0]);

    const result = await provider.summarizeAndTag(
      "text",
      "title",
      "url",
      "sk-test",
    );

    expect(result).toEqual(taggingResult);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to defaults for malformed LLM output", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "A summary",
                  sourceType: "INVALID",
                  topics: "not-an-array",
                  technologies: ["React"],
                }),
              },
            },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    const result = await provider.summarizeAndTag(
      "text",
      "title",
      "url",
      "sk-test",
    );

    expect(result).toEqual({
      summary: "A summary",
      sourceType: "unknown",
      topics: [],
      technologies: ["React"],
      intent: "reference",
    });
  });
});

describe("testOpenAIConnection", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns success for a valid key", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    const result = await testOpenAIConnection("sk-valid");

    expect(result).toEqual({
      success: true,
      message: "Connection successful",
    });
  });

  it("returns failure for an invalid key", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401 });

    const result = await testOpenAIConnection("sk-invalid");

    expect(result).toEqual({
      success: false,
      message: "Invalid API key",
    });
  });

  it("returns failure on network error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("Network error"));

    const result = await testOpenAIConnection("sk-test");

    expect(result).toEqual({ success: false, message: "Network error" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test src/worker/llm/OpenAIProvider.test.ts
```

Expected: FAIL with `Failed to resolve import "./OpenAIProvider"`.

- [ ] **Step 3: Add OpenAI provider implementation**

Create `src/worker/llm/OpenAIProvider.ts`:

```ts
import type { Intent, SourceType, TaggingResult } from "../../shared/types";

export type PageTagger = {
  summarizeAndTag(
    fullText: string,
    title: string,
    url: string,
    apiKey: string,
  ): Promise<TaggingResult>;
};

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];

const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set<SourceType>([
  "official_docs",
  "github_issue",
  "stackoverflow",
  "blog",
  "paper",
  "course_material",
  "unknown",
]);

const VALID_INTENTS: ReadonlySet<string> = new Set<Intent>([
  "learning",
  "debugging",
  "reference",
  "implementation",
  "comparison",
]);

const SYSTEM_PROMPT = `You are a technical document classifier for a developer's browsing history. Analyze the web page and return a JSON object with these exact fields:

- "summary" (string): 1-3 concise sentences summarizing the page content for a developer.
- "sourceType" (string): One of "official_docs", "github_issue", "stackoverflow", "blog", "paper", "course_material", "unknown".
- "topics" (string[]): 2-5 lowercase topic tags.
- "technologies" (string[]): Specific technologies or libraries mentioned.
- "intent" (string): One of "learning", "debugging", "reference", "implementation", "comparison".

Return ONLY the JSON object.`;

export class OpenAIProvider implements PageTagger {
  constructor(private readonly retryDelays: number[] = DEFAULT_RETRY_DELAYS) {}

  async summarizeAndTag(
    fullText: string,
    title: string,
    url: string,
    apiKey: string,
  ): Promise<TaggingResult> {
    const truncatedText = fullText.slice(0, MAX_TEXT_LENGTH);
    const userPrompt = `Page title: ${title}\nPage URL: ${url}\n\nPage content:\n${truncatedText}`;

    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const responseBody = await this.fetchWithRetry(apiKey, body);

    return parseTaggingResponse(responseBody);
  }

  private async fetchWithRetry(
    apiKey: string,
    body: string,
  ): Promise<unknown> {
    const maxAttempts = this.retryDelays.length + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });

      if (response.ok) {
        return response.json();
      }

      if (response.status === 401) {
        throw new Error("Invalid API key");
      }

      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < maxAttempts - 1
      ) {
        await sleep(this.retryDelays[attempt]);
        continue;
      }

      throw new Error(`OpenAI API error: ${response.status}`);
    }

    throw new Error("OpenAI API request failed after retries");
  }
}

function parseTaggingResponse(body: unknown): TaggingResult {
  const data = body as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("No content in OpenAI response");
  }

  const parsed = JSON.parse(content) as Record<string, unknown>;

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    sourceType: VALID_SOURCE_TYPES.has(parsed.sourceType as string)
      ? (parsed.sourceType as SourceType)
      : "unknown",
    topics: Array.isArray(parsed.topics)
      ? parsed.topics.filter((t): t is string => typeof t === "string")
      : [],
    technologies: Array.isArray(parsed.technologies)
      ? parsed.technologies.filter((t): t is string => typeof t === "string")
      : [],
    intent: VALID_INTENTS.has(parsed.intent as string)
      ? (parsed.intent as Intent)
      : "reference",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function testOpenAIConnection(
  apiKey: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    });

    if (response.ok) {
      return { success: true, message: "Connection successful" };
    }

    if (response.status === 401) {
      return { success: false, message: "Invalid API key" };
    }

    return { success: false, message: `API error: ${response.status}` };
  } catch {
    return { success: false, message: "Network error" };
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm test src/worker/llm/OpenAIProvider.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/llm/OpenAIProvider.ts src/worker/llm/OpenAIProvider.test.ts
git commit -m "feat: add openai provider with retry and response parsing"
```

## Task 4: Extend Page Repository

**Files:**
- Modify: `src/worker/repository/PageRepo.ts`
- Modify: `src/worker/repository/PageRepo.test.ts`

- [ ] **Step 1: Write failing repository tests for new methods**

Append these tests inside the existing `describe("PageRepo")` block in `src/worker/repository/PageRepo.test.ts`, after the last `it(...)`:

```ts
  it("retrieves a page by id", async () => {
    const page = await repo.upsertCapturedPage({
      url: "https://react.dev/reference/react/useState",
      title: "useState",
      fullText: "Returns a stateful value.",
      readingTimeMs: 5000,
      saveMode: "manual",
    });

    const found = await repo.getById(page.id);

    expect(found).toMatchObject({ id: page.id, title: "useState" });
  });

  it("returns undefined for a missing id", async () => {
    const found = await repo.getById("01NONEXISTENT0000000000000");

    expect(found).toBeUndefined();
  });

  it("updates a page with partial data", async () => {
    const page = await repo.upsertCapturedPage({
      url: "https://react.dev/reference/react/useEffect",
      title: "useEffect",
      fullText: "Lets you synchronize a component.",
      readingTimeMs: 6000,
      saveMode: "manual",
    });

    await repo.updatePage(page.id, {
      summary: "Synchronizes a component with an external system.",
      sourceType: "official_docs",
      topics: ["react", "hooks"],
      technologies: ["React"],
      intent: "reference",
      status: "ready",
    });

    const updated = await repo.getById(page.id);

    expect(updated).toMatchObject({
      id: page.id,
      title: "useEffect",
      summary: "Synchronizes a component with an external system.",
      sourceType: "official_docs",
      topics: ["react", "hooks"],
      technologies: ["React"],
      intent: "reference",
      status: "ready",
    });
  });
```

- [ ] **Step 2: Update existing test assertions for pending status**

In `src/worker/repository/PageRepo.test.ts`, change all `status: "ready"` assertions to `status: "pending"` in the existing three tests.

In the first test (`"stores a manually captured page with M2 defaults"`), line 39:

```ts
      status: "pending",
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm test src/worker/repository/PageRepo.test.ts
```

Expected: FAIL because `status` is still `"ready"`, and `getById`/`updatePage` do not exist.

- [ ] **Step 4: Update PageRepo implementation**

Replace `src/worker/repository/PageRepo.ts` with:

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
      status: "pending",
      schemaVersion: 1,
    };

    await this.database.pages.put(page);

    return page;
  }

  async getById(id: string): Promise<PageRecord | undefined> {
    return this.database.pages.get(id);
  }

  async updatePage(
    id: string,
    data: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
  ): Promise<void> {
    await this.database.pages.update(id, data);
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
git add src/worker/repository/PageRepo.ts src/worker/repository/PageRepo.test.ts
git commit -m "feat: pending status default with getById and updatePage"
```

## Task 5: Add Two-Phase Capture Processing

**Files:**
- Modify: `src/worker/services/CaptureService.ts`
- Modify: `src/worker/services/CaptureService.test.ts`

- [ ] **Step 1: Write failing processPage tests**

Replace `src/worker/services/CaptureService.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";

import type { ExtractedPage, PageRecord, TaggingResult } from "../../shared/types";
import {
  CaptureService,
  type PageExtractor,
  type PageReader,
  type PageTagger,
  type PageWriter,
} from "./CaptureService";

const extracted: ExtractedPage = {
  url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
  title: "Horizontal Pod Autoscaling",
  fullText: "Autoscaling docs",
  readingTimeMs: 30_000,
};

const pendingPage: PageRecord = {
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
  status: "pending",
  schemaVersion: 1,
};

const taggingResult: TaggingResult = {
  summary: "HPA autoscales pods based on metrics.",
  sourceType: "official_docs",
  topics: ["kubernetes", "autoscaling"],
  technologies: ["Kubernetes"],
  intent: "reference",
};

describe("CaptureService", () => {
  it("extracts the tab and stores a pending page", async () => {
    const extractor: PageExtractor = {
      extract: vi.fn().mockResolvedValue(extracted),
    };
    const writer: PageWriter = {
      upsertCapturedPage: vi.fn().mockResolvedValue(pendingPage),
    };

    const result = await new CaptureService(writer, extractor).save(123);

    expect(extractor.extract).toHaveBeenCalledWith(123);
    expect(writer.upsertCapturedPage).toHaveBeenCalledWith({
      ...extracted,
      saveMode: "manual",
    });
    expect(result).toBe(pendingPage);
  });

  it("enriches a pending page with LLM tagging", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = {
      summarizeAndTag: vi.fn().mockResolvedValue(taggingResult),
    };

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
    ).processPage(pendingPage.id, "sk-test");

    expect(tagger.summarizeAndTag).toHaveBeenCalledWith(
      pendingPage.fullText,
      pendingPage.title,
      pendingPage.url,
      "sk-test",
    );
    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      ...taggingResult,
      status: "ready",
    });
    expect(result.status).toBe("ready");
    expect(result.summary).toBe(taggingResult.summary);
  });

  it("marks a page as failed when LLM tagging throws", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = {
      summarizeAndTag: vi.fn().mockRejectedValue(new Error("rate_limited")),
    };

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
    ).processPage(pendingPage.id, "sk-test");

    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      status: "failed",
      errorReason: "rate_limited",
    });
    expect(result.status).toBe("failed");
    expect(result.errorReason).toBe("rate_limited");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test src/worker/services/CaptureService.test.ts
```

Expected: FAIL because `PageReader`, `PageTagger`, and `processPage` do not exist.

- [ ] **Step 3: Update CaptureService implementation**

Replace `src/worker/services/CaptureService.ts` with:

```ts
import type {
  ContentExtractRequest,
  ContentExtractResponse,
} from "../../shared/messages";
import type {
  ExtractedPage,
  PageCaptureInput,
  PageRecord,
  TaggingResult,
} from "../../shared/types";
import {
  OpenAIProvider,
  type PageTagger as OpenAIPageTagger,
} from "../llm/OpenAIProvider";
import { PageRepo } from "../repository/PageRepo";

export type PageExtractor = {
  extract(tabId: number): Promise<ExtractedPage>;
};

export type PageWriter = {
  upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord>;
};

export type PageReader = {
  getById(id: string): Promise<PageRecord | undefined>;
  updatePage(
    id: string,
    data: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
  ): Promise<void>;
};

export type PageTagger = OpenAIPageTagger;

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
    private readonly writer: PageWriter = new PageRepo(),
    private readonly extractor: PageExtractor = new ChromePageExtractor(),
    private readonly reader: PageReader = new PageRepo(),
    private readonly tagger: PageTagger = new OpenAIProvider(),
  ) {}

  async save(tabId: number): Promise<PageRecord> {
    const extracted = await this.extractor.extract(tabId);

    return this.writer.upsertCapturedPage({
      ...extracted,
      saveMode: "manual",
    });
  }

  async processPage(pageId: string, apiKey: string): Promise<PageRecord> {
    const page = await this.reader.getById(pageId);

    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }

    try {
      const result = await this.tagger.summarizeAndTag(
        page.fullText,
        page.title,
        page.url,
        apiKey,
      );

      await this.reader.updatePage(pageId, { ...result, status: "ready" });

      return { ...page, ...result, status: "ready" };
    } catch (error) {
      const errorReason =
        error instanceof Error ? error.message : "Unknown error";

      await this.reader.updatePage(pageId, {
        status: "failed",
        errorReason,
      });

      return { ...page, status: "failed", errorReason };
    }
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm test src/worker/services/CaptureService.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/services/CaptureService.ts src/worker/services/CaptureService.test.ts
git commit -m "feat: two-phase capture with async llm processing"
```

## Task 6: Wire Worker Dispatch

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/worker/index.test.ts`

- [ ] **Step 1: Update worker tests**

Replace `src/worker/index.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";

import { APP_NAME, APP_VERSION } from "../shared/messages";
import type { PageListItem, PageRecord } from "../shared/types";
import { handleRequest } from "./index";

const pendingPage = {
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
  status: "pending",
  schemaVersion: 1,
} satisfies PageRecord;

const pendingListItem = {
  id: pendingPage.id,
  url: pendingPage.url,
  title: pendingPage.title,
  domain: pendingPage.domain,
  sourceType: pendingPage.sourceType,
  summary: pendingPage.summary,
  topics: pendingPage.topics,
  technologies: pendingPage.technologies,
  savedAt: pendingPage.savedAt,
  status: pendingPage.status,
} satisfies PageListItem;

describe("worker request handler", () => {
  it("responds to a ping request", async () => {
    await expect(
      handleRequest({ type: "devrecall.ping" }, makeDeps()),
    ).resolves.toEqual({
      type: "devrecall.pong",
      payload: { appName: APP_NAME, version: APP_VERSION },
    });
  });

  it("returns settings status with hasApiKey from store", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });

    await expect(
      handleRequest({ type: "settings.getStatus" }, deps),
    ).resolves.toEqual({
      type: "settings.status",
      payload: { hasApiKey: true, persistentStorage: "unknown" },
    });
  });

  it("returns hasApiKey false when no key is stored", async () => {
    const deps = makeDeps({ apiKey: null });

    await expect(
      handleRequest({ type: "settings.getStatus" }, deps),
    ).resolves.toEqual({
      type: "settings.status",
      payload: { hasApiKey: false, persistentStorage: "unknown" },
    });
  });

  it("stores an API key", async () => {
    const deps = makeDeps();

    await expect(
      handleRequest(
        { type: "settings.setApiKey", payload: { apiKey: "sk-new" } },
        deps,
      ),
    ).resolves.toEqual({ type: "settings.apiKeySet" });
    expect(deps.apiKeyStore.setApiKey).toHaveBeenCalledWith("sk-new");
  });

  it("tests the OpenAI connection", async () => {
    const deps = makeDeps({
      apiKey: "sk-test",
      connectionResult: { success: true, message: "Connection successful" },
    });

    await expect(
      handleRequest({ type: "settings.testConnection" }, deps),
    ).resolves.toEqual({
      type: "settings.connectionTestResult",
      payload: { success: true, message: "Connection successful" },
    });
  });

  it("saves the active tab as a pending page", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.captureService.save = vi.fn().mockResolvedValue(pendingPage);

    await expect(
      handleRequest(
        { type: "page.save", payload: { tabId: 7 } },
        deps,
      ),
    ).resolves.toEqual({
      type: "page.saved",
      payload: { page: pendingListItem },
    });
    expect(deps.captureService.save).toHaveBeenCalledWith(7);
  });

  it("lists saved pages through PageRepo", async () => {
    const deps = makeDeps();
    deps.pageRepo.listPages = vi.fn().mockResolvedValue([pendingListItem]);

    await expect(
      handleRequest(
        { type: "page.list", payload: { limit: 25 } },
        deps,
      ),
    ).resolves.toEqual({
      type: "page.listed",
      payload: { pages: [pendingListItem] },
    });
    expect(deps.pageRepo.listPages).toHaveBeenCalledWith({ limit: 25 });
  });
});

function makeDeps(
  overrides: {
    apiKey?: string | null;
    connectionResult?: { success: boolean; message: string };
  } = {},
) {
  return {
    captureService: {
      save: vi.fn().mockResolvedValue(pendingPage),
      processPage: vi.fn().mockResolvedValue(pendingPage),
    },
    pageRepo: {
      listPages: vi.fn().mockResolvedValue([]),
    },
    apiKeyStore: {
      getApiKey: vi.fn().mockResolvedValue(overrides.apiKey ?? null),
      setApiKey: vi.fn().mockResolvedValue(undefined),
    },
    testConnection: vi
      .fn()
      .mockResolvedValue(
        overrides.connectionResult ?? {
          success: true,
          message: "Connection successful",
        },
      ),
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test src/worker/index.test.ts
```

Expected: FAIL because `handleRequest` signature does not accept the new deps shape and does not handle new message types.

- [ ] **Step 3: Update worker dispatch**

Replace `src/worker/index.ts` with:

```ts
import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
} from "../shared/messages";
import type { PageListItem, PageRecord } from "../shared/types";
import {
  testOpenAIConnection,
} from "./llm/OpenAIProvider";
import { PageRepo, toPageListItem } from "./repository/PageRepo";
import { CaptureService } from "./services/CaptureService";
import { ChromeApiKeyStore, type ApiKeyStore } from "./settings/ApiKeyStore";

type CapturePort = {
  save(tabId: number): Promise<PageRecord>;
  processPage(pageId: string, apiKey: string): Promise<PageRecord>;
};

type PageListPort = {
  listPages(input: { limit: number }): Promise<PageListItem[]>;
};

type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
  apiKeyStore: ApiKeyStore;
  testConnection: (
    apiKey: string,
  ) => Promise<{ success: boolean; message: string }>;
};

const pageRepo = new PageRepo();
const defaultDeps: HandlerDeps = {
  captureService: new CaptureService(pageRepo, undefined, pageRepo),
  pageRepo,
  apiKeyStore: new ChromeApiKeyStore(),
  testConnection: testOpenAIConnection,
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

    case "settings.getStatus": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      return {
        type: "settings.status",
        payload: {
          hasApiKey: apiKey !== null,
          persistentStorage: "unknown",
        },
      };
    }

    case "settings.setApiKey": {
      await deps.apiKeyStore.setApiKey(request.payload.apiKey);

      return { type: "settings.apiKeySet" };
    }

    case "settings.testConnection": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      if (!apiKey) {
        return {
          type: "settings.connectionTestResult",
          payload: { success: false, message: "No API key set" },
        };
      }

      const result = await deps.testConnection(apiKey);

      return {
        type: "settings.connectionTestResult",
        payload: result,
      };
    }

    case "page.save": {
      const page = await deps.captureService.save(request.payload.tabId);
      const apiKey = await deps.apiKeyStore.getApiKey();

      if (apiKey) {
        void deps.captureService
          .processPage(page.id, apiKey)
          .catch((error) => {
            console.error("[DevRecall] LLM processing error:", error);
          });
      }

      return {
        type: "page.saved",
        payload: {
          page: toPageListItem(page),
        },
      };
    }

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
      void handleRequest(request).then(sendResponse).catch((error) => {
        console.error("[DevRecall] handler error:", error);
      });
      return true;
    },
  );
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm test src/worker/index.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts src/worker/index.test.ts
git commit -m "feat: wire api key and llm processing into worker dispatch"
```

## Task 7: Wire Options Page

**Files:**
- Modify: `src/options/Options.tsx`
- Modify: `src/options/Options.test.tsx`

- [ ] **Step 1: Replace options tests with API key coverage**

Replace `src/options/Options.test.tsx` with:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Options } from "./Options";

function renderOptions(
  overrides: {
    hasApiKey?: boolean;
    connectionResult?: { success: boolean; message: string };
  } = {},
) {
  return render(
    <Options
      loadStatus={vi
        .fn()
        .mockResolvedValue({ hasApiKey: overrides.hasApiKey ?? false })}
      saveApiKey={vi.fn().mockResolvedValue(undefined)}
      testConnection={vi
        .fn()
        .mockResolvedValue(
          overrides.connectionResult ?? {
            success: true,
            message: "Connection successful",
          },
        )}
    />,
  );
}

describe("Options", () => {
  it("renders the settings form", async () => {
    renderOptions();

    expect(
      screen.getByRole("heading", { name: "DevRecall Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save key" }),
    ).toBeDisabled();
  });

  it("enables save button when API key is entered", async () => {
    const user = userEvent.setup();

    renderOptions();

    await user.type(screen.getByLabelText("OpenAI API key"), "sk-test123");

    expect(screen.getByRole("button", { name: "Save key" })).toBeEnabled();
  });

  it("saves an API key", async () => {
    const user = userEvent.setup();
    const saveApiKey = vi.fn().mockResolvedValue(undefined);

    render(
      <Options
        loadStatus={vi.fn().mockResolvedValue({ hasApiKey: false })}
        saveApiKey={saveApiKey}
        testConnection={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("OpenAI API key"), "sk-new");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(saveApiKey).toHaveBeenCalledWith("sk-new");
    expect(
      await screen.findByRole("button", { name: "Test connection" }),
    ).toBeEnabled();
  });

  it("tests connection and shows success", async () => {
    const user = userEvent.setup();
    const testConnection = vi
      .fn()
      .mockResolvedValue({ success: true, message: "Connection successful" });

    render(
      <Options
        loadStatus={vi.fn().mockResolvedValue({ hasApiKey: true })}
        saveApiKey={vi.fn().mockResolvedValue(undefined)}
        testConnection={testConnection}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Test connection" }),
    );

    expect(
      await screen.findByText("Connection successful"),
    ).toBeInTheDocument();
  });

  it("shows error when connection test fails", async () => {
    const user = userEvent.setup();
    const testConnection = vi
      .fn()
      .mockResolvedValue({ success: false, message: "Invalid API key" });

    render(
      <Options
        loadStatus={vi.fn().mockResolvedValue({ hasApiKey: true })}
        saveApiKey={vi.fn().mockResolvedValue(undefined)}
        testConnection={testConnection}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Test connection" }),
    );

    expect(await screen.findByText("Invalid API key")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test src/options/Options.test.tsx
```

Expected: FAIL because `Options` does not accept the new props.

- [ ] **Step 3: Implement options page**

Replace `src/options/Options.tsx` with:

```tsx
import { useEffect, useState } from "react";

import type { DevRecallRequest, DevRecallResponse } from "../shared/messages";
import { SurfaceShell } from "../ui/components";

type OptionsProps = {
  loadStatus?: () => Promise<{ hasApiKey: boolean }>;
  saveApiKey?: (apiKey: string) => Promise<void>;
  testConnection?: () => Promise<{ success: boolean; message: string }>;
};

async function defaultLoadStatus(): Promise<{ hasApiKey: boolean }> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return { hasApiKey: false };
  }

  const request: DevRecallRequest = { type: "settings.getStatus" };
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as DevRecallResponse;

  if (response.type !== "settings.status") {
    return { hasApiKey: false };
  }

  return { hasApiKey: response.payload.hasApiKey };
}

async function defaultSaveApiKey(apiKey: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("Chrome extension APIs are unavailable");
  }

  const request: DevRecallRequest = {
    type: "settings.setApiKey",
    payload: { apiKey },
  };

  await chrome.runtime.sendMessage(request);
}

async function defaultTestConnection(): Promise<{
  success: boolean;
  message: string;
}> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return { success: false, message: "Chrome extension APIs are unavailable" };
  }

  const request: DevRecallRequest = { type: "settings.testConnection" };
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as DevRecallResponse;

  if (response.type !== "settings.connectionTestResult") {
    return { success: false, message: "Unexpected response" };
  }

  return response.payload;
}

export function Options({
  loadStatus = defaultLoadStatus,
  saveApiKey = defaultSaveApiKey,
  testConnection = defaultTestConnection,
}: OptionsProps) {
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void loadStatus().then((status) => {
      if (status.hasApiKey) {
        setKeySaved(true);
      }
    });
  }, [loadStatus]);

  async function handleSave() {
    await saveApiKey(apiKey);
    setKeySaved(true);
    setTestResult(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);

    const result = await testConnection();

    setTestResult(result);
    setTesting(false);
  }

  return (
    <SurfaceShell title="DevRecall Settings">
      <form className="mx-auto flex max-w-2xl flex-col gap-6">
        <label className="flex flex-col gap-2 text-sm font-medium text-slate-800">
          OpenAI API key
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              placeholder={keySaved ? "API key is set" : "sk-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={!apiKey.trim()}
              onClick={handleSave}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:bg-slate-200 disabled:text-slate-500"
            >
              Save key
            </button>
          </div>
        </label>

        <button
          type="button"
          disabled={!keySaved || testing}
          onClick={handleTest}
          className="w-fit rounded-md bg-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:text-slate-400"
        >
          {testing ? "Testing..." : "Test connection"}
        </button>

        {testResult ? (
          <p
            className={`text-sm ${testResult.success ? "text-green-600" : "text-red-600"}`}
          >
            {testResult.message}
          </p>
        ) : null}

        <label className="flex items-center gap-3 text-sm font-medium text-slate-800">
          <input type="checkbox" disabled className="h-4 w-4 accent-accent" />
          Enable auto-save
          <span className="text-xs text-slate-400">(coming soon)</span>
        </label>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Storage</h2>
          <p className="mt-2 text-sm text-slate-500">
            0 pages, 0 chunks, 0 MB
          </p>
        </section>
      </form>
    </SurfaceShell>
  );
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm test src/options/Options.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/Options.tsx src/options/Options.test.tsx
git commit -m "feat: wire options page api key input and test connection"
```

## Task 8: Update UI Status Display And Popup API Key Check

**Files:**
- Modify: `src/ui/components/PageCard.tsx`
- Modify: `src/popup/Popup.tsx`
- Modify: `src/popup/Popup.test.tsx`

- [ ] **Step 1: Update PageCard with status indicators**

Replace `src/ui/components/PageCard.tsx` with:

```tsx
import type { PageListItem } from "../../shared/types";

type PageCardProps = {
  page: PageListItem;
};

export function PageCard({ page }: PageCardProps) {
  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{page.title}</h2>
        <StatusBadge status={page.status} />
      </div>
      <p className="mt-1 text-xs text-slate-500">{page.domain}</p>
      <p className="mt-2 line-clamp-2 text-sm text-slate-600">
        {page.summary || page.url}
      </p>
      {page.topics.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {page.topics.map((topic) => (
            <span
              key={topic}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
            >
              {topic}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function StatusBadge({ status }: { status: PageListItem["status"] }) {
  switch (status) {
    case "pending":
      return (
        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
          Processing…
        </span>
      );
    case "failed":
      return (
        <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
          Failed
        </span>
      );
    case "ready":
      return null;
  }
}
```

- [ ] **Step 2: Replace popup tests with API key gating**

Replace `src/popup/Popup.test.tsx` with:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Popup } from "./Popup";

describe("Popup", () => {
  it("disables save when no API key is set", async () => {
    render(
      <Popup
        checkApiKey={vi.fn().mockResolvedValue(false)}
        saveCurrentPage={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Save this page" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Set API key in settings"),
    ).toBeInTheDocument();
  });

  it("enables save when API key is set", async () => {
    render(
      <Popup
        checkApiKey={vi.fn().mockResolvedValue(true)}
        saveCurrentPage={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Save this page" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Set API key in settings"),
    ).not.toBeInTheDocument();
  });

  it("saves the current page and shows a saved state", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockResolvedValue(undefined);

    render(
      <Popup
        checkApiKey={vi.fn().mockResolvedValue(true)}
        saveCurrentPage={saveCurrentPage}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Save this page" }),
    );

    expect(saveCurrentPage).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: "Saved" }),
    ).toBeEnabled();
  });

  it("shows an error state when save fails", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockRejectedValue(new Error("no tab"));

    render(
      <Popup
        checkApiKey={vi.fn().mockResolvedValue(true)}
        saveCurrentPage={saveCurrentPage}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Save this page" }),
    );

    expect(
      await screen.findByText("Failed to save page"),
    ).toBeInTheDocument();
  });

  it("opens the side panel through the injected callback", async () => {
    const user = userEvent.setup();
    const openSidePanel = vi.fn();

    render(
      <Popup
        openSidePanel={openSidePanel}
        checkApiKey={vi.fn().mockResolvedValue(true)}
        saveCurrentPage={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Open library" }),
    );

    expect(openSidePanel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm test src/popup/Popup.test.tsx
```

Expected: FAIL because `Popup` does not accept `checkApiKey` and does not disable save without a key.

- [ ] **Step 4: Implement popup API key gating**

Replace `src/popup/Popup.tsx` with:

```tsx
import { useEffect, useState } from "react";

import type { DevRecallRequest, DevRecallResponse } from "../shared/messages";
import { SurfaceShell } from "../ui/components";

type SaveState = "idle" | "saving" | "saved" | "failed";

type PopupProps = {
  openSidePanel?: () => void;
  saveCurrentPage?: () => Promise<void>;
  checkApiKey?: () => Promise<boolean>;
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

async function defaultCheckApiKey(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return false;
  }

  const request: DevRecallRequest = { type: "settings.getStatus" };
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as DevRecallResponse;

  if (response.type !== "settings.status") {
    return false;
  }

  return response.payload.hasApiKey;
}

export function Popup({
  openSidePanel = defaultOpenSidePanel,
  saveCurrentPage = defaultSaveCurrentPage,
  checkApiKey = defaultCheckApiKey,
}: PopupProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  useEffect(() => {
    void checkApiKey().then(setHasApiKey);
  }, [checkApiKey]);

  const loading = hasApiKey === null;
  const canSave = hasApiKey === true && saveState !== "saving";

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
          disabled={loading || !canSave}
          onClick={handleSave}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300 disabled:text-slate-600"
        >
          {saveState === "saving"
            ? "Saving..."
            : saveState === "saved"
              ? "Saved"
              : "Save this page"}
        </button>

        {hasApiKey === false ? (
          <p className="text-xs text-amber-600">
            Set API key in settings
          </p>
        ) : saveState === "failed" ? (
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

- [ ] **Step 5: Verify all UI tests pass**

Run:

```bash
pnpm test src/popup/Popup.test.tsx src/options/Options.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/PageCard.tsx src/popup/Popup.tsx src/popup/Popup.test.tsx
git commit -m "feat: status badges in page card and api key gating in popup"
```

## Task 9: Final M3 Verification

**Files:**
- Review all files changed in Tasks 1–8.

- [ ] **Step 1: Add coverage paths for new modules**

In `vitest.config.ts`, update the `coverage.include` array to also cover the new modules:

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "html"],
  include: [
    "src/lib/**/*.ts",
    "src/worker/services/**/*.ts",
    "src/worker/llm/**/*.ts",
    "src/worker/settings/**/*.ts",
  ],
},
```

- [ ] **Step 2: Run the full automated suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all commands pass.

- [ ] **Step 3: Manually smoke test the extension build**

Run:

```bash
pnpm build
```

Then load the extension from `dist/` in Chrome:

1. Open `chrome://extensions`, enable Developer mode, click "Load unpacked", select `dist/`.
2. Open the options page. Enter a valid OpenAI API key, click "Save key". Click "Test connection" — confirm it shows "Connection successful".
3. Open an HTTP(S) documentation page.
4. Click the DevRecall toolbar icon. Confirm "Save this page" button is enabled.
5. Click "Save this page". Confirm it transitions to "Saving..." → "Saved".
6. Open the side panel. Confirm the saved page appears with a "Processing…" badge initially, then transitions to show a summary and topic tags once LLM completes.
7. Remove the API key from the options page (clear input, save empty). Reopen the popup. Confirm "Save this page" is disabled with "Set API key in settings" message.

Expected: two-phase save creates a pending page, LLM enriches it to ready with summary and tags, popup blocks save without key.

- [ ] **Step 4: Check M3 scope boundaries**

Run:

```bash
grep -rn "embedding\|chunk\|ChunkRecord\|auto.save\|autoSave" src/ --include="*.ts" --include="*.tsx"
```

Expected: no M3 code introduces embeddings, chunking, or auto-save logic. Existing M1 skeleton references in options (`Enable auto-save` checkbox is disabled) are acceptable.

- [ ] **Step 5: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only M3 plan file, M3 implementation files, and vitest.config.ts are changed.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: complete m3 llm tagging milestone"
```

## Self-Review Notes

- Spec coverage: M3 requires LLM-generated summary/tags via OpenAI, pending/ready/failed states visible, options page API key input. Tasks 3, 5, 6, 7, and 8 cover those requirements.
- Architecture coverage: API key lives in `chrome.storage.local` (Task 2). OpenAI called via direct `fetch` with 3-attempt exponential backoff (Task 3). Two-phase save: pending → async LLM → ready/failed (Tasks 4–6). Popup checks API key on mount (Task 8). PageCard shows status badges (Task 8).
- M3 boundaries: no embeddings, no chunking, no search, no auto-save, no retry button (M6 scope). Pages that fail can be re-saved from the popup to trigger reprocessing.
- Type consistency: `TaggingResult` defined once in `types.ts`, consumed by `OpenAIProvider`, `CaptureService`, and `PageRepo.updatePage`. `PageTagger` interface defined in `OpenAIProvider.ts`, re-exported from `CaptureService.ts`. `ApiKeyStore` interface defined in `ApiKeyStore.ts`, used by worker `HandlerDeps`.
- Test updates: all existing tests that asserted `status: "ready"` are updated to `status: "pending"` to match the new two-phase default. New tests cover API key storage, OpenAI provider (happy path, retry, malformed output), processPage (success and failure), worker dispatch (all new handlers), options page (save, test), popup (API key gating).
