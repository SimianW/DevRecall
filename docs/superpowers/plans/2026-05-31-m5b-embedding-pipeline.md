# M5b — Embedding Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make page capture produce embeddings — `processPage` re-chunks `fullText` with `js-tiktoken`, embeds the chunks in one batched OpenAI call, and atomically persists the token chunks + L2-normalized vectors + token counts while flipping the page to `ready`.

**Architecture:** Second of four M5 plans (M5a ✅ → **M5b** → M5c → M5d). M5b folds embedding into the **existing** `processPage` phase (parent spec "Approach A") — no new page status, no third pipeline phase. It adds an `Embedder` port (implemented by `OpenAIProvider` and a new `MockLLMProvider`), the optional embedding fields on `ChunkRecord`, and a single cross-table transaction (`ChunkRepo.commitProcessedPage`) that swaps in the embedded chunks and flips the page to `ready` together, so a half-embedded page never exists. Retrieval is **unchanged** this plan — keyword search keeps running over the new chunks' `.text`; the vectors sit unused until M5c reads them.

**Tech Stack:** TypeScript strict mode, Dexie (IndexedDB), Vitest, `fake-indexeddb`, `js-tiktoken` (from M5a), OpenAI `/v1/embeddings` (`text-embedding-3-small`, 1536-dim).

**Parent spec:** [`docs/superpowers/specs/2026-05-31-m5-hybrid-retrieval-design.md`](../specs/2026-05-31-m5-hybrid-retrieval-design.md) — §4.1 (ChunkRecord fields), §4.3 (no schema bump), §5 (Approach A), §8 (files).

**Depends on M5a:** `lib/tokenChunking.ts` (`chunkTokens`) and `lib/vector.ts` (`normalize`) must already exist and be green.

---

## Scope

M5b implements the embedding write-path:

- `ChunkRecord` gains optional `embedding?: Float32Array`, `embeddingModel?: string`, `tokenCount?: number`. No Dexie version bump (these fields are not indexed — see parent spec §4.3).
- `Embedder` port + `OpenAIProvider.embed` / `embedBatch` (POST `/v1/embeddings`), returning **L2-normalized** `Float32Array`s.
- `MockLLMProvider` — deterministic hash-based 1536-dim embeddings + canned tags, for integration tests.
- `ChunkRepo.commitProcessedPage` — one `rw` transaction over `pages` + `chunks`: replace the page's chunks with embedded ones, then flip the page record.
- `CaptureService.processPage` — extended per Approach A: tag → token-chunk → batch-embed → atomic commit. Failures keep the page keyword-searchable on its existing word chunks.
- Worker wires a shared `OpenAIProvider` instance as both tagger and embedder.

Out of scope:

- Reading vectors at query time, RRF fusion, `PageHit.scores`, query embedding → **M5c**.
- `page.updated` broadcast (parent spec §5 shows it inside `processPage`), live refresh, delete, re-index, keyboard shortcut, in-memory chunk array + LRU cache, "matched by meaning" badge → **M5d**.

Baseline before plan creation (run these to confirm green):

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all pass, with M5a's `tokenChunking`, `vector`, `rrf`, and CJK `bm25` suites present.

## File Structure

- Modify `src/shared/types.ts` — add the three optional `ChunkRecord` fields.
- Modify `src/worker/llm/OpenAIProvider.ts` and `src/worker/llm/OpenAIProvider.test.ts` — `Embedder` port + `embed`/`embedBatch`.
- Create `src/worker/llm/MockLLMProvider.ts` and `src/worker/llm/MockLLMProvider.test.ts`.
- Modify `src/worker/repository/ChunkRepo.ts` and `src/worker/repository/ChunkRepo.test.ts` — `EmbeddedChunkInput`, `commitProcessedPage`.
- Modify `src/worker/services/CaptureService.ts` and `src/worker/services/CaptureService.test.ts` — Approach A `processPage`.
- Modify `src/worker/index.ts` — inject the shared provider as embedder.

---

## Task 1: Add embedding fields to ChunkRecord

**Files:**

- Modify: `src/shared/types.ts:70-76`

- [ ] **Step 1: Extend the `ChunkRecord` type**

Replace the existing `ChunkRecord` definition in `src/shared/types.ts` (lines 70–76) with:

```ts
export type ChunkRecord = {
  id: string; // ULID
  pageId: string; // FK → PageRecord.id
  ordinal: number; // 0-based position within the page
  text: string; // word-window until processPage re-chunks it to token-based
  embedding?: Float32Array; // 1536 dims, L2-normalized at insert; absent until embedded
  embeddingModel?: string; // e.g. "openai:text-embedding-3-small"; absent until embedded
  tokenCount?: number; // tiktoken count; metadata only, not used by retrieval scoring
  schemaVersion: 1;
};
```

- [ ] **Step 2: Verify the project still typechecks and tests pass**

```bash
pnpm typecheck
pnpm test
```

Expected: PASS. The new fields are optional, so every existing `ChunkRecord` literal (which omits them) is still valid, and no Dexie migration is needed — the fields are not indexed (parent spec §4.3).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add optional embedding fields to ChunkRecord"
```

---

## Task 2: Embedder port and OpenAI embeddings

**Files:**

- Modify: `src/worker/llm/OpenAIProvider.ts`
- Test: `src/worker/llm/OpenAIProvider.test.ts`

The `Embedder` port returns **already-normalized** vectors — normalization is enforced inside the provider, not left to callers (parent spec §5: "Enforced in the pipeline, not left to callers"). So both the write path (`processPage`) and the query path (M5c) receive unit vectors and never re-normalize. The existing chat retry/error handling is reused by refactoring `fetchWithRetry` to take a URL.

- [ ] **Step 1: Write the failing tests**

Append to `src/worker/llm/OpenAIProvider.test.ts`. First extend the import on line 4:

```ts
import { EMBEDDING_MODEL_ID, OpenAIProvider, testOpenAIConnection } from "./OpenAIProvider";
import { dot } from "../../lib/vector";
```

Then add a new `describe` block:

```ts
describe("OpenAIProvider embeddings", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to the embeddings endpoint and returns normalized vectors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { index: 0, embedding: [3, 4] },
            { index: 1, embedding: [0, 5] },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    const vectors = await provider.embedBatch(["alpha", "beta"], "sk-test");

    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0])).toEqual([0.6, 0.8]); // 3-4-5 triangle, normalized
    expect(dot(vectors[1], vectors[1])).toBeCloseTo(1, 6); // unit length

    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(options?.body as string)).toEqual({
      model: "text-embedding-3-small",
      input: ["alpha", "beta"],
    });
  });

  it("reorders rows by their response index", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    const vectors = await provider.embedBatch(["first", "second"], "sk-test");

    expect(Array.from(vectors[0])).toEqual([1, 0]); // index 0 first
    expect(Array.from(vectors[1])).toEqual([0, 1]);
  });

  it("embeds a single text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ index: 0, embedding: [0, 3] }] }),
    });
    const provider = new OpenAIProvider([]);

    const vector = await provider.embed("solo", "sk-test");

    expect(Array.from(vector)).toEqual([0, 1]);
  });

  it("returns an empty array without calling fetch for empty input", async () => {
    globalThis.fetch = vi.fn();
    const provider = new OpenAIProvider([]);

    const vectors = await provider.embedBatch([], "sk-test");

    expect(vectors).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on a 401 from the embeddings endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const provider = new OpenAIProvider([]);

    await expect(provider.embedBatch(["x"], "sk-bad")).rejects.toThrow("Invalid API key");
  });

  it("throws when the response shape is wrong", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }), // count mismatch
    });
    const provider = new OpenAIProvider([]);

    await expect(provider.embedBatch(["x"], "sk-test")).rejects.toThrow();
  });

  it("exposes a stable embedding model id", () => {
    expect(new OpenAIProvider([]).embeddingModel).toBe(EMBEDDING_MODEL_ID);
    expect(EMBEDDING_MODEL_ID).toBe("openai:text-embedding-3-small");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test src/worker/llm/OpenAIProvider.test.ts
```

Expected: FAIL — `embedBatch`/`embed`/`EMBEDDING_MODEL_ID` do not exist; the existing tagging tests still pass.

- [ ] **Step 3: Add the embeddings implementation**

In `src/worker/llm/OpenAIProvider.ts`:

(a) Add the import at the top, after the existing type import:

```ts
import type { Intent, SourceType, TaggingResult } from "../../shared/types";
import { normalize } from "../../lib/vector";
```

(b) Add the `Embedder` port type just below the existing `PageTagger` type (after line 10):

```ts
export type Embedder = {
  readonly embeddingModel: string;
  embed(text: string, apiKey: string): Promise<Float32Array>;
  embedBatch(texts: string[], apiKey: string): Promise<Float32Array[]>;
};
```

(c) Add constants next to the existing `OPENAI_CHAT_URL`/`MODEL` constants:

```ts
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_MODEL_ID = "openai:text-embedding-3-small";
```

(d) Change the class declaration to implement `Embedder` too, and add the model id field:

```ts
export class OpenAIProvider implements PageTagger, Embedder {
  readonly embeddingModel = EMBEDDING_MODEL_ID;

  constructor(private readonly retryDelays: number[] = DEFAULT_RETRY_DELAYS) {}
```

(e) Refactor `fetchWithRetry` to take a URL. Change its signature and the `fetch` call inside it:

```ts
  private async fetchWithRetry(url: string, apiKey: string, body: string): Promise<unknown> {
    const maxAttempts = this.retryDelays.length + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(url, {
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

      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts - 1) {
        await sleep(this.retryDelays[attempt]);
        continue;
      }

      throw new Error(`OpenAI API error: ${response.status}`);
    }

    throw new Error("OpenAI API request failed after retries");
  }
```

(f) Update the existing `summarizeAndTag` call site (it currently calls `this.fetchWithRetry(apiKey, body)`):

```ts
    const responseBody = await this.fetchWithRetry(OPENAI_CHAT_URL, apiKey, body);
```

(g) Add the two embedding methods to the class (e.g. just after `summarizeAndTag`):

```ts
  async embedBatch(texts: string[], apiKey: string): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const body = JSON.stringify({ model: EMBEDDING_MODEL, input: texts });
    const responseBody = await this.fetchWithRetry(OPENAI_EMBEDDINGS_URL, apiKey, body);

    return parseEmbeddingResponse(responseBody, texts.length);
  }

  async embed(text: string, apiKey: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text], apiKey);
    return vector;
  }
```

(h) Add the response parser as a module-level function (next to `parseTaggingResponse`):

```ts
function parseEmbeddingResponse(body: unknown, expectedCount: number): Float32Array[] {
  const data = body as { data?: Array<{ embedding?: number[]; index?: number }> };

  if (!Array.isArray(data.data) || data.data.length !== expectedCount) {
    throw new Error("Unexpected embedding response shape");
  }

  return [...data.data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row) => {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new Error("Missing embedding in OpenAI response");
      }

      return normalize(Float32Array.from(row.embedding));
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test src/worker/llm/OpenAIProvider.test.ts
```

Expected: PASS — both the new embeddings block and all pre-existing tagging/connection tests (the `fetchWithRetry` URL refactor is internal; `summarizeAndTag` still posts to the chat URL).

- [ ] **Step 5: Commit**

```bash
git add src/worker/llm/OpenAIProvider.ts src/worker/llm/OpenAIProvider.test.ts
git commit -m "feat: add OpenAI embeddings via Embedder port"
```

---

## Task 3: MockLLMProvider

**Files:**

- Create: `src/worker/llm/MockLLMProvider.ts`
- Test: `src/worker/llm/MockLLMProvider.test.ts`

A deterministic, network-free implementation of both `PageTagger` and `Embedder` for integration tests. Embeddings are a hash-seeded pseudo-random 1536-dim vector, L2-normalized — so the same text always yields the same unit vector, and different texts yield different vectors. (Ranking-specific fixtures with controlled cosine similarity live in M5c's retrieval test, not here — a hash vector has no semantic structure.)

- [ ] **Step 1: Write the failing test**

Create `src/worker/llm/MockLLMProvider.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { dot } from "../../lib/vector";
import { MockLLMProvider } from "./MockLLMProvider";

describe("MockLLMProvider", () => {
  const provider = new MockLLMProvider();

  it("returns canned, valid tags", async () => {
    const result = await provider.summarizeAndTag("body", "Title", "https://x.test", "sk");

    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.sourceType).toBe("official_docs");
    expect(Array.isArray(result.topics)).toBe(true);
  });

  it("produces a normalized 1536-dim vector", async () => {
    const vector = await provider.embed("hello", "sk");

    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(1536);
    expect(dot(vector, vector)).toBeCloseTo(1, 5);
  });

  it("is deterministic for the same text", async () => {
    const a = await provider.embed("kubernetes autoscaling", "sk");
    const b = await provider.embed("kubernetes autoscaling", "sk");

    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces different vectors for different text", async () => {
    const [a, b] = await provider.embedBatch(["alpha", "beta"], "sk");

    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("exposes a mock model id", () => {
    expect(provider.embeddingModel).toBe("mock:embedding");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/worker/llm/MockLLMProvider.test.ts
```

Expected: FAIL — `Failed to resolve import "./MockLLMProvider"`.

- [ ] **Step 3: Write the implementation**

Create `src/worker/llm/MockLLMProvider.ts`:

```ts
import { normalize } from "../../lib/vector";
import type { TaggingResult } from "../../shared/types";
import type { Embedder, PageTagger } from "./OpenAIProvider";

const EMBEDDING_DIM = 1536;

/**
 * Deterministic, network-free tagger + embedder for integration tests. The
 * embedding is a hash-seeded pseudo-random unit vector: stable per input,
 * distinct across inputs. It carries no semantics — tests that assert ranking
 * by meaning supply their own controlled vectors (see M5c).
 */
export class MockLLMProvider implements PageTagger, Embedder {
  readonly embeddingModel = "mock:embedding";

  async summarizeAndTag(
    _fullText: string,
    title: string,
    _url: string,
    _apiKey: string,
  ): Promise<TaggingResult> {
    return {
      summary: `Mock summary of "${title}".`,
      sourceType: "official_docs",
      topics: ["mock"],
      technologies: [],
      intent: "reference",
    };
  }

  async embed(text: string, _apiKey: string): Promise<Float32Array> {
    return hashEmbedding(text);
  }

  async embedBatch(texts: string[], _apiKey: string): Promise<Float32Array[]> {
    return texts.map((text) => hashEmbedding(text));
  }
}

function hashEmbedding(text: string): Float32Array {
  // FNV-1a hash of the text seeds a mulberry32 PRNG; fill then L2-normalize.
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  let state = seed >>> 0;
  const vector = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    vector[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  }

  return normalize(vector);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test src/worker/llm/MockLLMProvider.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/worker/llm/MockLLMProvider.ts src/worker/llm/MockLLMProvider.test.ts
git commit -m "test: add deterministic MockLLMProvider for integration tests"
```

---

## Task 4: ChunkRepo.commitProcessedPage (atomic upgrade)

**Files:**

- Modify: `src/worker/repository/ChunkRepo.ts`
- Test: `src/worker/repository/ChunkRepo.test.ts`

`commitProcessedPage` is the single `rw` transaction over **both** the `pages` and `chunks` tables that the parent spec (§5) calls "the upgrade": it deletes the page's existing (word) chunks, inserts the embedded token chunks, and applies the page update — atomically, so a half-embedded page never exists. It lives on `ChunkRepo` because it is fundamentally a chunk-replacement that also flips a status flag; the small page update is passed in as data.

- [ ] **Step 1: Write the failing tests**

Append to `src/worker/repository/ChunkRepo.test.ts`. Extend the imports and add a `PageRecord` builder + new cases:

```ts
import type { PageRecord } from "../../shared/types";

function makePage(id: string, status: PageRecord["status"]): PageRecord {
  return {
    id,
    url: `https://example.test/${id}`,
    urlHash: id.padEnd(64, "0"),
    title: "T",
    domain: "example.test",
    sourceType: "unknown",
    summary: "",
    topics: [],
    technologies: [],
    intent: "reference",
    fullText: "full text",
    savedAt: 1,
    visitedAt: 1,
    readingTimeMs: 0,
    saveMode: "manual",
    status,
    schemaVersion: 1,
  };
}

describe("ChunkRepo.commitProcessedPage", () => {
  let database: DevRecallDatabase;
  let repo: ChunkRepo;

  beforeEach(async () => {
    database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    repo = new ChunkRepo(database);
    await database.delete();
    await database.open();
  });

  it("writes embedded chunks and flips the page in one transaction", async () => {
    await database.pages.put(makePage("page-1", "pending"));

    const records = await repo.commitProcessedPage(
      "page-1",
      [
        { text: "chunk a", embedding: Float32Array.from([1, 0]), tokenCount: 2 },
        { text: "chunk b", embedding: Float32Array.from([0, 1]), tokenCount: 3 },
      ],
      "openai:text-embedding-3-small",
      { status: "ready", summary: "done" },
    );

    expect(records.map((r) => r.ordinal)).toEqual([0, 1]);

    const stored = await repo.allChunks();
    expect(stored).toHaveLength(2);
    const first = stored.find((c) => c.ordinal === 0)!;
    expect(first.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(first.embedding!)).toEqual([1, 0]);
    expect(first.embeddingModel).toBe("openai:text-embedding-3-small");
    expect(first.tokenCount).toBe(2);

    const page = await database.pages.get("page-1");
    expect(page?.status).toBe("ready");
    expect(page?.summary).toBe("done");
  });

  it("replaces pre-existing word chunks for the page", async () => {
    await database.pages.put(makePage("page-1", "pending"));
    await repo.replaceChunksForPage("page-1", ["old word chunk"]);

    await repo.commitProcessedPage(
      "page-1",
      [{ text: "new token chunk", embedding: Float32Array.from([1]), tokenCount: 4 }],
      "openai:text-embedding-3-small",
      { status: "ready" },
    );

    const stored = await repo.allChunks();
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("new token chunk");
    expect(stored[0].embedding).toBeInstanceOf(Float32Array);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test src/worker/repository/ChunkRepo.test.ts
```

Expected: the existing `replaceChunksForPage`/`deleteForPage` tests PASS; the new `commitProcessedPage` cases FAIL (method does not exist).

- [ ] **Step 3: Add `EmbeddedChunkInput` and `commitProcessedPage`**

In `src/worker/repository/ChunkRepo.ts`:

(a) Extend the type import:

```ts
import type { ChunkRecord, PageRecord } from "../../shared/types";
```

(b) Add the input DTO above the class:

```ts
export type EmbeddedChunkInput = {
  text: string;
  embedding: Float32Array;
  tokenCount: number;
};
```

(c) Add the method to the `ChunkRepo` class (e.g. after `replaceChunksForPage`):

```ts
  async commitProcessedPage(
    pageId: string,
    chunks: EmbeddedChunkInput[],
    embeddingModel: string,
    pageUpdate: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
  ): Promise<ChunkRecord[]> {
    const records: ChunkRecord[] = chunks.map((chunk, ordinal) => ({
      id: ulid(),
      pageId,
      ordinal,
      text: chunk.text,
      embedding: chunk.embedding,
      embeddingModel,
      tokenCount: chunk.tokenCount,
      schemaVersion: 1,
    }));

    await this.database.transaction("rw", this.database.pages, this.database.chunks, async () => {
      await this.database.chunks.where("pageId").equals(pageId).delete();

      if (records.length > 0) {
        await this.database.chunks.bulkPut(records);
      }

      await this.database.pages.update(pageId, pageUpdate);
    });

    return records;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test src/worker/repository/ChunkRepo.test.ts
```

Expected: PASS — all ChunkRepo cases, including the two new ones. Note `Float32Array` survives Dexie/`fake-indexeddb` structured clone and reads back as a `Float32Array` (parent spec §4.1).

- [ ] **Step 5: Commit**

```bash
git add src/worker/repository/ChunkRepo.ts src/worker/repository/ChunkRepo.test.ts
git commit -m "feat: add atomic commitProcessedPage to ChunkRepo"
```

---

## Task 5: Embed inside processPage (Approach A)

**Files:**

- Modify: `src/worker/services/CaptureService.ts`
- Test: `src/worker/services/CaptureService.test.ts`

`processPage` now tags, then re-chunks `fullText` with `chunkTokens`, batch-embeds the chunk texts, and commits the embedded chunks + the `ready` flip in one transaction. On any failure (tag *or* embed) the page is marked `failed` and its existing word chunks are left untouched, so it stays keyword-searchable (parent spec §5).

- [ ] **Step 1: Write/replace the failing tests**

Replace the entire body of `src/worker/services/CaptureService.test.ts` with the following. (It keeps the `save` test, rewrites the two `processPage` tests to inject embedder + chunk-writer mocks, adds an embed-failure test, and adds a real-DB integration test with `MockLLMProvider`.)

```ts
import { describe, expect, it, vi } from "vitest";

import type { ExtractedPage, PageRecord, TaggingResult } from "../../shared/types";
import { ChunkRepo } from "../repository/ChunkRepo";
import { DevRecallDatabase } from "../repository/db";
import { PageRepo } from "../repository/PageRepo";
import { MockLLMProvider } from "../llm/MockLLMProvider";
import type { Embedder } from "../llm/OpenAIProvider";
import {
  CaptureService,
  type ChunkWriter,
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

function mockEmbedder(overrides: Partial<Embedder> = {}): Embedder {
  return {
    embeddingModel: "mock:embedding",
    embed: vi.fn(),
    embedBatch: vi.fn().mockResolvedValue([Float32Array.from([1, 0, 0])]),
    ...overrides,
  };
}

function mockChunkWriter(): ChunkWriter {
  return {
    replaceChunksForPage: vi.fn().mockResolvedValue([]),
    commitProcessedPage: vi.fn().mockResolvedValue([]),
  };
}

describe("CaptureService", () => {
  it("extracts the tab, stores a pending page, and writes word chunks", async () => {
    const extractor: PageExtractor = { extract: vi.fn().mockResolvedValue(extracted) };
    const writer: PageWriter = { upsertCapturedPage: vi.fn().mockResolvedValue(pendingPage) };
    const chunkWriter = mockChunkWriter();

    const result = await new CaptureService(
      writer,
      extractor,
      undefined,
      undefined,
      chunkWriter,
    ).save(123);

    expect(extractor.extract).toHaveBeenCalledWith(123);
    expect(writer.upsertCapturedPage).toHaveBeenCalledWith({ ...extracted, saveMode: "manual" });
    expect(chunkWriter.replaceChunksForPage).toHaveBeenCalledWith(pendingPage.id, [
      pendingPage.fullText,
    ]);
    expect(result).toBe(pendingPage);
  });

  it("tags, embeds, and commits the page atomically", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(tagger.summarizeAndTag).toHaveBeenCalledWith(
      pendingPage.fullText,
      pendingPage.title,
      pendingPage.url,
      "sk-test",
    );
    expect(embedder.embedBatch).toHaveBeenCalledOnce();
    expect(chunkWriter.commitProcessedPage).toHaveBeenCalledWith(
      pendingPage.id,
      expect.any(Array),
      "mock:embedding",
      { ...taggingResult, status: "ready" },
    );
    expect(reader.updatePage).not.toHaveBeenCalled();
    expect(result.status).toBe("ready");
    expect(result.summary).toBe(taggingResult.summary);
  });

  it("marks a page failed when tagging throws, before embedding", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = {
      summarizeAndTag: vi.fn().mockRejectedValue(new Error("rate_limited")),
    };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(chunkWriter.commitProcessedPage).not.toHaveBeenCalled();
    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      status: "failed",
      errorReason: "rate_limited",
    });
    expect(result.status).toBe("failed");
  });

  it("marks a page failed when embedding throws, keeping chunks untouched", async () => {
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder({
      embedBatch: vi.fn().mockRejectedValue(new Error("network")),
    });

    const result = await new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    ).processPage(pendingPage.id, "sk-test");

    expect(chunkWriter.commitProcessedPage).not.toHaveBeenCalled();
    expect(reader.updatePage).toHaveBeenCalledWith(pendingPage.id, {
      status: "failed",
      errorReason: "network",
    });
    expect(result.status).toBe("failed");
  });

  it("embeds chunks and marks the page ready end-to-end (integration)", async () => {
    const database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    await database.delete();
    await database.open();

    const pageRepo = new PageRepo(database);
    const chunkRepo = new ChunkRepo(database);
    const mock = new MockLLMProvider();

    const saved = await pageRepo.upsertCapturedPage({
      url: extracted.url,
      title: extracted.title,
      fullText:
        "The HorizontalPodAutoscaler automatically scales workloads based on observed CPU metrics.",
      readingTimeMs: 1000,
      saveMode: "manual",
    });

    const service = new CaptureService(
      pageRepo,
      { extract: vi.fn() },
      pageRepo,
      mock,
      chunkRepo,
      mock,
    );
    const result = await service.processPage(saved.id, "sk-test");

    expect(result.status).toBe("ready");

    const stored = await chunkRepo.allChunks();
    expect(stored.length).toBeGreaterThan(0);
    for (const chunk of stored) {
      expect(chunk.embedding).toBeInstanceOf(Float32Array);
      expect(chunk.embedding?.length).toBe(1536);
      expect(chunk.embeddingModel).toBe("mock:embedding");
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }

    const reread = await pageRepo.getById(saved.id);
    expect(reread?.status).toBe("ready");
    expect(reread?.summary).not.toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test src/worker/services/CaptureService.test.ts
```

Expected: FAIL — `CaptureService` does not yet accept an `embedder` param, `ChunkWriter` has no `commitProcessedPage`, and `processPage` still only tags.

- [ ] **Step 3: Extend `CaptureService`**

In `src/worker/services/CaptureService.ts`:

(a) Update the imports:

```ts
import type { ContentExtractRequest, ContentExtractResponse } from "../../shared/messages";
import type { ChunkRecord, ExtractedPage, PageCaptureInput, PageRecord } from "../../shared/types";
import { chunkText } from "../../lib/chunking";
import { chunkTokens } from "../../lib/tokenChunking";
import {
  OpenAIProvider,
  type Embedder,
  type PageTagger as OpenAIPageTagger,
} from "../llm/OpenAIProvider";
import { ChunkRepo, type EmbeddedChunkInput } from "../repository/ChunkRepo";
import { PageRepo } from "../repository/PageRepo";
```

(b) Extend the `ChunkWriter` port type (replace the existing one):

```ts
export type ChunkWriter = {
  replaceChunksForPage(pageId: string, texts: string[]): Promise<ChunkRecord[]>;
  commitProcessedPage(
    pageId: string,
    chunks: EmbeddedChunkInput[],
    embeddingModel: string,
    pageUpdate: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
  ): Promise<ChunkRecord[]>;
};
```

(c) Add an `embedder` constructor parameter (after `chunkWriter`):

```ts
  constructor(
    private readonly writer: PageWriter = new PageRepo(),
    private readonly extractor: PageExtractor = new ChromePageExtractor(),
    private readonly reader: PageReader = new PageRepo(),
    private readonly tagger: PageTagger = new OpenAIProvider(),
    private readonly chunkWriter: ChunkWriter = new ChunkRepo(),
    private readonly embedder: Embedder = new OpenAIProvider(),
  ) {}
```

(d) Replace the body of `processPage`:

```ts
  async processPage(pageId: string, apiKey: string): Promise<PageRecord> {
    const page = await this.reader.getById(pageId);

    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }

    try {
      const result = await this.tagger.summarizeAndTag(page.fullText, page.title, page.url, apiKey);

      const tokenChunks = chunkTokens(page.fullText);
      const vectors = await this.embedder.embedBatch(
        tokenChunks.map((chunk) => chunk.text),
        apiKey,
      );
      const embedded: EmbeddedChunkInput[] = tokenChunks.map((chunk, index) => ({
        text: chunk.text,
        embedding: vectors[index],
        tokenCount: chunk.tokenCount,
      }));

      await this.chunkWriter.commitProcessedPage(pageId, embedded, this.embedder.embeddingModel, {
        ...result,
        status: "ready",
      });

      return { ...page, ...result, status: "ready" };
    } catch (error) {
      const errorReason = error instanceof Error ? error.message : "Unknown error";

      await this.reader.updatePage(pageId, { status: "failed", errorReason });

      return { ...page, status: "failed", errorReason };
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test src/worker/services/CaptureService.test.ts
```

Expected: PASS (5 tests, including the integration test).

- [ ] **Step 5: Commit**

```bash
git add src/worker/services/CaptureService.ts src/worker/services/CaptureService.test.ts
git commit -m "feat: embed token chunks inside processPage (Approach A)"
```

---

## Task 6: Wire the embedder into the worker

**Files:**

- Modify: `src/worker/index.ts:9-47`

The worker currently builds `CaptureService` without a tagger or embedder (it relied on the constructor defaults). Wire a single shared `OpenAIProvider` instance into both the tagger and embedder slots so production capture actually embeds.

- [ ] **Step 1: Import the provider class and share one instance**

In `src/worker/index.ts`, change the OpenAI import (currently `import { testOpenAIConnection } from "./llm/OpenAIProvider";`) to:

```ts
import { OpenAIProvider, testOpenAIConnection } from "./llm/OpenAIProvider";
```

Then update the dependency wiring (lines ~39–47) to construct and inject the shared provider:

```ts
const pageRepo = new PageRepo();
const chunkRepo = new ChunkRepo();
const openai = new OpenAIProvider();
const defaultDeps: HandlerDeps = {
  captureService: new CaptureService(pageRepo, undefined, pageRepo, openai, chunkRepo, openai),
  pageRepo,
  apiKeyStore: new ChromeApiKeyStore(),
  testConnection: testOpenAIConnection,
  retrievalService: new RetrievalService(chunkRepo, pageRepo),
};
```

- [ ] **Step 2: Run the worker tests and typecheck**

```bash
pnpm test src/worker/index.test.ts
pnpm typecheck
```

Expected: PASS. The worker request handlers are tested with injected mock deps, so changing `defaultDeps` does not affect them; this only changes what the production worker constructs.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: wire OpenAI embedder into worker capture pipeline"
```

---

## Task 7: Final M5b verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite, typecheck, and lint**

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all PASS.

- [ ] **Step 2: Build and re-check the worker bundle size (js-tiktoken now in the worker path)**

```bash
pnpm build
ls -lh dist/assets/*.js | sort -k5 -h | tail -5
```

Expected: build succeeds. Unlike M5a, `processPage` now imports `chunkTokens`, so `js-tiktoken`'s `cl100k_base` rank data is pulled into the worker bundle. Compare the largest chunk against the M5a baseline. The parent spec (§10) flags this: if the bundle grows materially, lazy-load the encoder via dynamic `import("js-tiktoken")` inside `chunkTokens`/`processPage` so it stays off the search path. Record the measured size; only act if it is a problem.

- [ ] **Step 3: Confirm retrieval is unchanged**

```bash
rg -n "embedding|cosineTopK|reciprocalRankFusion|scores" src/worker/services/RetrievalService.ts
```

Expected: no matches. `RetrievalService` still does keyword-only BM25 over chunk `.text`; reading vectors and fusing is M5c. Manual sanity (optional): load the unpacked build, set an API key, save a page, and confirm it still reaches `ready` and is keyword-searchable in the side panel.

- [ ] **Step 4: Inspect the diff scope**

```bash
git diff --stat main..HEAD
```

Expected: changes limited to M5a files (already merged) plus `src/shared/types.ts`, `src/worker/llm/*`, `src/worker/repository/ChunkRepo*`, `src/worker/services/CaptureService*`, `src/worker/index.ts`, and the two M5 plan files. No `RetrievalService`, side panel, options, or manifest changes.

---

## Self-Review Notes

- **Spec coverage.** M5b delivers success criterion #1: "Saving a page with a valid API key produces token-based chunks, each with a stored 1536-dim embedding, and the page reaches `ready` only after both tags and embeddings are persisted." `processPage` (Task 5) tags → token-chunks → embeds → commits in one transaction; the integration test asserts ready-with-vectors end-to-end. It also implements the §4.1 ChunkRecord fields, the §5 Approach A pipeline and its decisions, and the `MockLLMProvider` / `OpenAIProvider.embed*` files from §8.
- **Normalization lives in the Embedder, not callers.** `OpenAIProvider.embedBatch` (and `MockLLMProvider`) return L2-normalized vectors. This makes the parent spec's "enforced in the pipeline, not left to callers" literally true: the write path stores unit vectors, and M5c's query path gets a unit vector from `embed()` for free — neither re-normalizes, and `cosineTopK` (M5a) can assume dot-product == cosine. `normalize` from `lib/vector.ts` gains its production caller here.
- **One transaction for the upgrade.** `commitProcessedPage` wraps chunk replacement *and* the page→`ready` flip in a single `rw` transaction over both tables (parent spec §5). If the worker dies mid-`processPage`, either nothing committed (page still `pending`, old word chunks intact) or everything committed (page `ready`, embedded chunks present) — never a half-embedded page. The method lives on `ChunkRepo` because it is a chunk replacement that also carries a small page update; this is a deliberate placement trade-off (a chunk repo touching the pages table) chosen over leaking a Dexie transaction handle into `CaptureService`.
- **Failure keeps the page keyword-searchable.** A throw from either `summarizeAndTag` or `embedBatch` lands in the existing catch → `updatePage(status:"failed")`, and `commitProcessedPage` is never reached, so the word chunks written by `save()` survive. Retry re-runs the whole `processPage` (cheap to redo; only the API calls cost money) — parent spec §5.
- **No Dexie version bump.** The three new `ChunkRecord` fields are not indexed, and Dexie versions track index declarations, not record shape (parent spec §4.3). Existing M4 chunk rows read back with the fields `undefined`; M5c's vector arm skips chunks without an `embedding`, which is the graceful-degradation path for un-re-indexed pages.
- **Error convention.** The plan keeps `OpenAIProvider`'s existing plain-`Error`-with-message convention (e.g. `"Invalid API key"`) for embeddings rather than introducing a structured `auth | rate_limited | network | parse | unknown` enum. The current M4 code does not actually have such an enum — `processPage` stores `error.message` as `errorReason` — so reusing the existing shape avoids inventing a type the codebase does not have. The spec's "M4 code set" reference is treated as conceptual.
- **Type consistency with siblings.** `chunkTokens` returns `TokenChunk` (`{ text, tokenCount }`, M5a) → mapped into `EmbeddedChunkInput` (`{ text, embedding, tokenCount }`, ChunkRepo) → stored as `ChunkRecord` fields. The `Embedder` port (`embeddingModel`, `embed`, `embedBatch`) is implemented identically by `OpenAIProvider` and `MockLLMProvider`, and is the same port M5c's vector arm will depend on for query embedding.
- **`MockLLMProvider` scope.** Hash-seeded vectors are stable and distinct but carry no semantics, so they prove the *pipeline* (ready-with-vectors) but cannot prove ranking-by-meaning. M5c's retrieval tests therefore inject their own controlled-vector fake for the "matched by meaning" assertion; `MockLLMProvider` stays the general integration double.
