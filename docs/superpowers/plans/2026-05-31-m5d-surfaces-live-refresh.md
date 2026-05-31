# M5d — Surfaces & Live Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the M5 user-facing surfaces — live side-panel refresh on capture, a keyboard shortcut to open the panel, single-page delete from the detail view, an Options "Re-index library" action for pre-embedding pages, the "matched by meaning" badge — and the retrieval cache (in-memory chunks + LRU queries) that the broadcasts invalidate.

**Architecture:** Fourth and final M5 plan (M5a ✅ → M5b ✅ → M5c ✅ → **M5d**). It introduces a worker→UI broadcast channel (`WorkerBroadcast`: `page.updated` / `page.removed` / `library.reindexProgress`) sent fire-and-forget via `chrome.runtime.sendMessage`. Mutating handlers emit a broadcast **and** call `RetrievalService.invalidate()` (the worker can't receive its own broadcasts, so cache invalidation is an in-process call at the same site). The side panel and Options subscribe via `chrome.runtime.onMessage` to update in place. Delete and re-index reuse atomic transactions/`processPage` from M5b. The keyboard shortcut opens the panel synchronously inside the `chrome.commands` event.

**Tech Stack:** TypeScript strict mode, React 18, Chrome MV3 (`commands`, `sidePanel`, `runtime` messaging), Dexie, Vitest, Testing Library.

**Parent spec:** [`docs/superpowers/specs/2026-05-31-m5-hybrid-retrieval-design.md`](../specs/2026-05-31-m5-hybrid-retrieval-design.md) — §4.4 (messages), §6.6 (caching), §7 (surfaces).

**Depends on:** M5a–M5c merged and green (token chunking, vector/rrf, embeddings, hybrid `RetrievalService`, `PageHit.scores`, `commitProcessedPage`).

---

## Scope

M5d delivers parent success criteria #5–#8 plus the caching from §6.6:

- `RetrievalService`: in-memory chunk array (feeds `bm25Search`, which derives `avgdl` from it) + LRU(20) `query → PageHit[]` cache + `invalidate()`.
- Message contract: `page.delete`, `library.reindex` requests; `page.deleted`, `library.reindexStarted` responses; `WorkerBroadcast` union.
- Worker: a fire-and-forget `broadcast()` helper; `page.save` emits `page.updated` after save and after `processPage`; `page.delete` and `library.reindex` handlers; `chrome.commands.onCommand` opening the side panel; `invalidate()` at every mutation.
- Atomic single-page delete (`PageRepo.deleteWithChunks`) and re-index of pages missing embeddings (`PageRepo.pageIdsMissingEmbeddings` + `CaptureService.reindexPages`).
- Side panel: `onMessage` live refresh of the library list; delete from the expanded card; "matched by meaning" badge for vector-only hits.
- Options: "Re-index library" control with progress and a missing-embeddings count.
- `manifest.config.ts`: a `commands` entry (default `Ctrl/Cmd+Shift+K`).

Out of scope (M6+ per parent spec §2): auto-save, export-all, delete-all, dark mode, filter-chip wiring, README GIF, ANN indexes, jieba segmenter.

Baseline before plan creation:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all pass with M5a–M5c merged.

## File Structure

- Modify `src/worker/services/RetrievalService.ts` and `RetrievalService.test.ts` — caching + `invalidate()`.
- Modify `src/shared/messages.ts` — request/response/broadcast additions; extend `storage.stats`.
- Modify `src/worker/index.ts` and `src/worker/index.test.ts` — broadcasts, `invalidate`, delete/reindex handlers, `onCommand`.
- Modify `src/worker/repository/PageRepo.ts` and `PageRepo.test.ts` — `deleteWithChunks`, `pageIdsMissingEmbeddings`, `getStats` field.
- Modify `src/worker/services/CaptureService.ts` and `CaptureService.test.ts` — `reindexPages`.
- Modify `manifest.config.ts` — `commands`.
- Modify `src/sidepanel/App.tsx` and `App.test.tsx` — live refresh + delete.
- Modify `src/ui/components/PageCard.tsx` — `onDelete`.
- Modify `src/ui/components/SearchResultCard.tsx` — badge labels.
- Modify `src/options/Options.tsx` and `Options.test.tsx` — re-index control.

---

## Task 1: Retrieval cache and invalidation

**Files:**

- Modify: `src/worker/services/RetrievalService.ts`
- Test: `src/worker/services/RetrievalService.test.ts`

Cache the loaded chunk array (so repeated queries don't re-read IndexedDB) and an LRU(20) of `query → PageHit[]` (so type-as-you-search is instant and doesn't re-embed). `invalidate()` clears both; the worker calls it whenever a page changes. `bm25Search` keeps deriving `avgdl` from the (now cached) chunk array, so no separate stats cache is needed (parent spec §4.2, §6.6).

- [ ] **Step 1: Write the failing tests**

Append to `src/worker/services/RetrievalService.test.ts` (the M5c helpers `keywordChunks`, `pages`, `fakeEmbedder` are in scope):

```ts
describe("RetrievalService caching", () => {
  function countingService() {
    const allChunks = vi.fn().mockResolvedValue(keywordChunks);
    const chunkSource: ChunkSource = { allChunks };
    const pageSource: PageSource = {
      getById: vi.fn().mockImplementation((id: string) => pages.get(id)),
    };
    return { service: new RetrievalService(chunkSource, pageSource, fakeEmbedder({})), allChunks };
  }

  it("loads chunks once across distinct queries, reloads after invalidate", async () => {
    const { service, allChunks } = countingService();

    await service.search("autoscaler");
    await service.search("hydration");
    expect(allChunks).toHaveBeenCalledTimes(1);

    service.invalidate();
    await service.search("autoscaler");
    expect(allChunks).toHaveBeenCalledTimes(2);
  });

  it("returns the cached result object for a repeated query", async () => {
    const { service, allChunks } = countingService();

    const first = await service.search("autoscaler pods");
    const second = await service.search("autoscaler pods");

    expect(second).toBe(first); // same reference from the query cache
    expect(allChunks).toHaveBeenCalledTimes(1);
  });

  it("drops cached query results on invalidate", async () => {
    const { service, allChunks } = countingService();

    const first = await service.search("autoscaler pods");
    service.invalidate();
    const second = await service.search("autoscaler pods");

    expect(second).not.toBe(first);
    expect(allChunks).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test src/worker/services/RetrievalService.test.ts
```

Expected: FAIL — `invalidate` does not exist and each `search` re-reads chunks.

- [ ] **Step 3: Add caching to RetrievalService**

Replace the entire contents of `src/worker/services/RetrievalService.ts` with (the M5c logic, now reading via `loadChunks()` and wrapped in a query cache):

```ts
import { bm25Search } from "../../lib/bm25";
import { highlightTerms } from "../../lib/highlight";
import { matchReasonFor, reciprocalRankFusion } from "../../lib/rrf";
import { cosineTopK } from "../../lib/vector";
import type { ChunkRecord, PageHit, PageRecord } from "../../shared/types";
import { OpenAIProvider, type Embedder } from "../llm/OpenAIProvider";
import { ChunkRepo } from "../repository/ChunkRepo";
import { PageRepo, toPageListItem } from "../repository/PageRepo";

export type ChunkSource = {
  allChunks(): Promise<ChunkRecord[]>;
};

export type PageSource = {
  getById(id: string): Promise<PageRecord | undefined>;
};

export type SearchOptions = {
  topK?: number;
  apiKey?: string | null;
};

const DEFAULT_TOP_K = 10;
const VECTOR_TOP_K = 50;
const MAX_QUERY_CACHE = 20;

type FusedChunk = {
  chunk: ChunkRecord;
  fused: number;
  keyword: number | null;
  vector: number | null;
  matchReason: PageHit["matchReason"];
  matchedTerms: string[];
};

export class RetrievalService {
  private chunkCache: ChunkRecord[] | null = null;
  private readonly queryCache = new Map<string, PageHit[]>();

  constructor(
    private readonly chunks: ChunkSource = new ChunkRepo(),
    private readonly pages: PageSource = new PageRepo(),
    private readonly embedder: Embedder = new OpenAIProvider(),
  ) {}

  /** Clears the in-memory chunk array and the query cache. Called on any page change. */
  invalidate(): void {
    this.chunkCache = null;
    this.queryCache.clear();
  }

  async search(query: string, options: SearchOptions = {}): Promise<PageHit[]> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const apiKey = options.apiKey ?? null;
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const cacheKey = `${apiKey ? "k" : "n"}|${topK}|${trimmed.toLowerCase()}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      // LRU touch: re-insert to mark most-recently-used.
      this.queryCache.delete(cacheKey);
      this.queryCache.set(cacheKey, cached);
      return cached;
    }

    const results = await this.computeSearch(trimmed, topK, apiKey);

    this.queryCache.set(cacheKey, results);
    if (this.queryCache.size > MAX_QUERY_CACHE) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) {
        this.queryCache.delete(oldest);
      }
    }

    return results;
  }

  private async loadChunks(): Promise<ChunkRecord[]> {
    if (this.chunkCache === null) {
      this.chunkCache = await this.chunks.allChunks();
    }
    return this.chunkCache;
  }

  private async computeSearch(
    trimmed: string,
    topK: number,
    apiKey: string | null,
  ): Promise<PageHit[]> {
    const allChunks = await this.loadChunks();

    if (allChunks.length === 0) {
      return [];
    }

    // Keyword arm — BM25-lite over every chunk's text (CJK-aware tokenizer).
    const keywordScore = new Map<string, number>();
    const matchedTerms = new Map<string, string[]>();
    const keywordRanking: string[] = [];
    for (const hit of bm25Search(
      trimmed,
      allChunks.map((c) => c.text),
    )) {
      const id = allChunks[hit.index].id;
      keywordRanking.push(id);
      keywordScore.set(id, hit.score);
      matchedTerms.set(id, hit.matchedTerms);
    }

    // Vector arm — only with an API key; chunks lacking an embedding drop out.
    const vectorScore = new Map<string, number>();
    const vectorRanking: string[] = [];
    if (apiKey) {
      try {
        const queryVector = await this.embedder.embed(trimmed, apiKey);
        for (const hit of cosineTopK(queryVector, allChunks, VECTOR_TOP_K)) {
          const id = allChunks[hit.index].id;
          vectorRanking.push(id);
          vectorScore.set(id, hit.score);
        }
      } catch {
        // Vector-arm failure (e.g. an embed error) degrades to keyword-only.
      }
    }

    const fused = reciprocalRankFusion(keywordRanking, vectorRanking);

    if (fused.size === 0) {
      return [];
    }

    const chunkById = new Map(allChunks.map((c): [string, ChunkRecord] => [c.id, c]));

    const bestByPage = new Map<string, FusedChunk>();
    for (const [id, entry] of fused) {
      const chunk = chunkById.get(id);
      if (!chunk) {
        continue;
      }

      const candidate: FusedChunk = {
        chunk,
        fused: entry.fused,
        keyword: keywordScore.get(id) ?? null,
        vector: vectorScore.get(id) ?? null,
        matchReason: matchReasonFor(entry),
        matchedTerms: matchedTerms.get(id) ?? [],
      };

      const current = bestByPage.get(chunk.pageId);
      if (!current || candidate.fused > current.fused) {
        bestByPage.set(chunk.pageId, candidate);
      }
    }

    const ranked = Array.from(bestByPage.values())
      .sort((left, right) => right.fused - left.fused)
      .slice(0, topK);

    const results: PageHit[] = [];
    for (const entry of ranked) {
      const page = await this.pages.getById(entry.chunk.pageId);
      if (!page) {
        continue;
      }

      results.push({
        page: toPageListItem(page),
        bestChunk: {
          text: entry.chunk.text,
          ordinal: entry.chunk.ordinal,
          highlightedHtml: highlightTerms(entry.chunk.text, entry.matchedTerms),
        },
        scores: { keyword: entry.keyword, vector: entry.vector, fused: entry.fused },
        matchReason: entry.matchReason,
      });
    }

    return results;
  }
}
```

- [ ] **Step 4: Run the full RetrievalService suite to verify it passes**

```bash
pnpm test src/worker/services/RetrievalService.test.ts
```

Expected: PASS — the M5c hybrid tests (each uses a fresh service / single query, so the cache is transparent) and the three new caching tests.

- [ ] **Step 5: Commit**

```bash
git add src/worker/services/RetrievalService.ts src/worker/services/RetrievalService.test.ts
git commit -m "feat: cache chunks and queries in RetrievalService with invalidate"
```

---

## Task 2: Message contract additions

**Files:**

- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Add the request members**

In `src/shared/messages.ts`, add to the `DevRecallRequest` union (after the `search.run` member; remember to change the preceding `;` to `|`-friendly punctuation):

```ts
  | { type: "search.run"; payload: { query: string; topK?: number } }
  | { type: "page.delete"; payload: { id: string } }
  | { type: "library.reindex" };
```

- [ ] **Step 2: Add the response members**

Add to the `DevRecallResponse` union, immediately before the `error` member:

```ts
  | { type: "page.deleted"; payload: { id: string } }
  | { type: "library.reindexStarted"; payload: { total: number } }
```

- [ ] **Step 3: Extend the storage stats payload**

Change the `storage.stats` response payload to include the missing-embeddings count:

```ts
  | {
      type: "storage.stats";
      payload: {
        pageCount: number;
        totalTextBytes: number;
        pagesMissingEmbeddings: number;
      };
    }
```

- [ ] **Step 4: Add the broadcast union**

Append a new exported union at the end of `src/shared/messages.ts` (worker → UI, fire-and-forget, no awaited response):

```ts
export type WorkerBroadcast =
  | { type: "page.updated"; payload: { page: PageListItem } }
  | { type: "page.removed"; payload: { id: string } }
  | { type: "library.reindexProgress"; payload: { done: number; total: number } };
```

- [ ] **Step 5: Verify typecheck (expected breakage points are listed)**

```bash
pnpm typecheck
```

Expected: errors only where the new `storage.stats` field is not yet produced — `PageRepo.getStats` and the `index.test.ts` `makeDeps` mock. Those are fixed in Task 5. (If you are running tasks strictly in order, this typecheck will be red until Task 5; that is expected for this contract-only task. Proceed.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat: add delete/reindex messages and worker broadcast union"
```

---

## Task 3: Worker broadcasts, invalidation, and capture refresh

**Files:**

- Modify: `src/worker/index.ts`
- Test: `src/worker/index.test.ts`

Add a fire-and-forget `broadcast()` helper, thread it (and `RetrievalService.invalidate()`) through `HandlerDeps`, and make `page.save` emit `page.updated` after the pending insert and again after `processPage`. The delete/reindex handlers (Tasks 4–5) reuse this plumbing.

- [ ] **Step 1: Update `makeDeps` and add failing tests**

In `src/worker/index.test.ts`, update `makeDeps` (lines ~204–234) so the mock deps include `broadcast`, an `invalidate`able retriever, and the new page-repo methods:

```ts
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
      reindexPages: vi.fn().mockResolvedValue(undefined),
    },
    pageRepo: {
      listPages: vi.fn().mockResolvedValue([]),
      getStats: vi
        .fn()
        .mockResolvedValue({ pageCount: 0, totalTextBytes: 0, pagesMissingEmbeddings: 0 }),
      getByUrlHash: vi.fn().mockResolvedValue(undefined),
      deleteWithChunks: vi.fn().mockResolvedValue(undefined),
      pageIdsMissingEmbeddings: vi.fn().mockResolvedValue([]),
    },
    apiKeyStore: {
      getApiKey: vi.fn().mockResolvedValue(overrides.apiKey ?? null),
      setApiKey: vi.fn().mockResolvedValue(undefined),
    },
    testConnection: vi.fn().mockResolvedValue(
      overrides.connectionResult ?? { success: true, message: "Connection successful" },
    ),
    retrievalService: {
      search: vi.fn().mockResolvedValue([]),
      invalidate: vi.fn(),
    },
    broadcast: vi.fn(),
  };
}
```

Add new tests inside `describe("worker request handler", ...)`:

```ts
  it("broadcasts page.updated and invalidates on save, then again after processing", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.captureService.save = vi.fn().mockResolvedValue(pendingPage);
    deps.captureService.processPage = vi
      .fn()
      .mockResolvedValue({ ...pendingPage, status: "ready" });

    await handleRequest({ type: "page.save", payload: { tabId: 7 } }, deps);

    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "page.updated",
      payload: { page: pendingListItem },
    });
    expect(deps.retrievalService.invalidate).toHaveBeenCalled();

    // The processPage continuation broadcasts a second page.updated.
    await vi.waitFor(() => {
      expect(deps.broadcast).toHaveBeenCalledWith({
        type: "page.updated",
        payload: { page: { ...pendingListItem, status: "ready" } },
      });
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/worker/index.test.ts
```

Expected: FAIL — `broadcast` is never called (and `deps` shape errors until the source is updated).

- [ ] **Step 3: Add the broadcast helper and thread it through deps**

In `src/worker/index.ts`:

(a) Extend the messages import to include `WorkerBroadcast`:

```ts
import {
  APP_NAME,
  APP_VERSION,
  type DevRecallRequest,
  type DevRecallResponse,
  type WorkerBroadcast,
} from "../shared/messages";
```

(b) Extend the port types: add `invalidate` to `SearchPort`, the new methods to `PageListPort` and `CapturePort`, and `broadcast` to `HandlerDeps`:

```ts
type CapturePort = {
  save(tabId: number): Promise<PageRecord>;
  processPage(pageId: string, apiKey: string): Promise<PageRecord>;
  reindexPages(
    pageIds: string[],
    apiKey: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<void>;
};

type PageListPort = {
  listPages(input: { limit: number }): Promise<PageListItem[]>;
  getStats(): Promise<{
    pageCount: number;
    totalTextBytes: number;
    pagesMissingEmbeddings: number;
  }>;
  getByUrlHash(urlHash: string): Promise<PageRecord | undefined>;
  deleteWithChunks(id: string): Promise<void>;
  pageIdsMissingEmbeddings(): Promise<string[]>;
};

type SearchPort = {
  search(
    query: string,
    options?: { topK?: number; apiKey?: string | null },
  ): Promise<PageHit[]>;
  invalidate(): void;
};

type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
  apiKeyStore: ApiKeyStore;
  testConnection: (apiKey: string) => Promise<{ success: boolean; message: string }>;
  retrievalService: SearchPort;
  broadcast: (message: WorkerBroadcast) => void;
};
```

(c) Add the `broadcast` helper (module-level, near the bottom helpers) and reference it in `defaultDeps`:

```ts
function broadcast(message: WorkerBroadcast): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return;
  }
  // Fire-and-forget. With no open receiver, Chrome rejects with
  // "Receiving end does not exist" — harmless here, so swallow it.
  void chrome.runtime.sendMessage(message).catch(() => {});
}
```

In `defaultDeps`, add the field:

```ts
  retrievalService: new RetrievalService(chunkRepo, pageRepo, openai),
  broadcast,
};
```

(d) Replace the `page.save` case to broadcast + invalidate:

```ts
    case "page.save": {
      const page = await deps.captureService.save(request.payload.tabId);
      const listItem = toPageListItem(page);

      deps.retrievalService.invalidate();
      deps.broadcast({ type: "page.updated", payload: { page: listItem } });

      const apiKey = await deps.apiKeyStore.getApiKey();
      if (apiKey) {
        void deps.captureService
          .processPage(page.id, apiKey)
          .then((processed) => {
            deps.retrievalService.invalidate();
            deps.broadcast({
              type: "page.updated",
              payload: { page: toPageListItem(processed) },
            });
          })
          .catch((error) => {
            console.error("[DevRecall] LLM processing error:", error);
          });
      }

      return { type: "page.saved", payload: { page: listItem } };
    }
```

- [ ] **Step 4: Run the worker tests**

```bash
pnpm test src/worker/index.test.ts
```

Expected: PASS — the new broadcast test plus all existing handler tests (now supplied with the richer mock deps).

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts src/worker/index.test.ts
git commit -m "feat: broadcast page.updated and invalidate cache on capture"
```

---

## Task 4: Atomic single-page delete

**Files:**

- Modify: `src/worker/repository/PageRepo.ts`
- Test: `src/worker/repository/PageRepo.test.ts`
- Modify: `src/worker/index.ts` and `src/worker/index.test.ts`

- [ ] **Step 1: Write the failing repo test**

Append to `src/worker/repository/PageRepo.test.ts` a test that a page and its chunks are deleted together. (Match the file's existing setup pattern — a fresh `DevRecallDatabase` per test. If helpers differ, adapt names to the file.)

```ts
import { ChunkRepo } from "./ChunkRepo";

it("deletes a page and its chunks in one transaction", async () => {
  // `database` and `repo` (PageRepo) come from the file's existing beforeEach.
  const chunkRepo = new ChunkRepo(database);

  const saved = await repo.upsertCapturedPage({
    url: "https://example.test/delete-me",
    title: "Delete me",
    fullText: "body",
    readingTimeMs: 0,
    saveMode: "manual",
  });
  await chunkRepo.replaceChunksForPage(saved.id, ["chunk one", "chunk two"]);

  await repo.deleteWithChunks(saved.id);

  expect(await repo.getById(saved.id)).toBeUndefined();
  expect(await chunkRepo.allChunks()).toHaveLength(0);
});
```

> If `PageRepo.test.ts` does not already create a shared `database`/`repo` in a `beforeEach`, add one mirroring `ChunkRepo.test.ts` (`database = new DevRecallDatabase(\`devrecall-test-${crypto.randomUUID()}\`); await database.delete(); await database.open(); repo = new PageRepo(database);`).

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test src/worker/repository/PageRepo.test.ts
```

Expected: FAIL — `deleteWithChunks` does not exist.

- [ ] **Step 3: Add `deleteWithChunks` to PageRepo**

In `src/worker/repository/PageRepo.ts`, add to the `PageRepo` class:

```ts
  async deleteWithChunks(id: string): Promise<void> {
    await this.database.transaction("rw", this.database.pages, this.database.chunks, async () => {
      await this.database.chunks.where("pageId").equals(id).delete();
      await this.database.pages.delete(id);
    });
  }
```

- [ ] **Step 4: Run to verify the repo test passes**

```bash
pnpm test src/worker/repository/PageRepo.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the failing worker handler test**

In `src/worker/index.test.ts`, add inside `describe("worker request handler", ...)`:

```ts
  it("deletes a page, invalidates, and broadcasts removal", async () => {
    const deps = makeDeps();

    await expect(
      handleRequest({ type: "page.delete", payload: { id: "page-1" } }, deps),
    ).resolves.toEqual({ type: "page.deleted", payload: { id: "page-1" } });

    expect(deps.pageRepo.deleteWithChunks).toHaveBeenCalledWith("page-1");
    expect(deps.retrievalService.invalidate).toHaveBeenCalled();
    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "page.removed",
      payload: { id: "page-1" },
    });
  });
```

- [ ] **Step 6: Add the `page.delete` handler**

In `src/worker/index.ts`, add a case before `default:`:

```ts
    case "page.delete": {
      await deps.pageRepo.deleteWithChunks(request.payload.id);
      deps.retrievalService.invalidate();
      deps.broadcast({ type: "page.removed", payload: { id: request.payload.id } });

      return { type: "page.deleted", payload: { id: request.payload.id } };
    }
```

- [ ] **Step 7: Run the worker test, typecheck**

```bash
pnpm test src/worker/index.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/worker/repository/PageRepo.ts src/worker/repository/PageRepo.test.ts src/worker/index.ts src/worker/index.test.ts
git commit -m "feat: atomic single-page delete with removal broadcast"
```

---

## Task 5: Re-index library

**Files:**

- Modify: `src/worker/repository/PageRepo.ts` and `PageRepo.test.ts`
- Modify: `src/worker/services/CaptureService.ts` and `CaptureService.test.ts`
- Modify: `src/worker/index.ts` and `src/worker/index.test.ts`

`pageIdsMissingEmbeddings` finds `ready` pages with no embedded chunk (M4 pages). `getStats` reports the count (for the Options button). `CaptureService.reindexPages` runs `processPage` per page sequentially, reporting progress. The `library.reindex` handler responds immediately with the total, then processes in the background, broadcasting progress and invalidating per page (parent spec §7.3).

- [ ] **Step 1: Write the failing repo tests**

Append to `src/worker/repository/PageRepo.test.ts`:

```ts
it("lists ready pages missing embeddings and counts them in stats", async () => {
  const chunkRepo = new ChunkRepo(database);

  const m4 = await repo.upsertCapturedPage({
    url: "https://example.test/m4",
    title: "M4 page",
    fullText: "body",
    readingTimeMs: 0,
    saveMode: "manual",
  });
  await repo.updatePage(m4.id, { status: "ready" });
  await chunkRepo.replaceChunksForPage(m4.id, ["word chunk, no vector"]);

  const m5 = await repo.upsertCapturedPage({
    url: "https://example.test/m5",
    title: "M5 page",
    fullText: "body",
    readingTimeMs: 0,
    saveMode: "manual",
  });
  await chunkRepo.commitProcessedPage(
    m5.id,
    [{ text: "token chunk", embedding: Float32Array.from([1, 0]), tokenCount: 2 }],
    "openai:text-embedding-3-small",
    { status: "ready" },
  );

  expect(await repo.pageIdsMissingEmbeddings()).toEqual([m4.id]);

  const stats = await repo.getStats();
  expect(stats.pagesMissingEmbeddings).toBe(1);
  expect(stats.pageCount).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test src/worker/repository/PageRepo.test.ts
```

Expected: FAIL — `pageIdsMissingEmbeddings` missing; `getStats` lacks `pagesMissingEmbeddings`.

- [ ] **Step 3: Add the repo methods**

In `src/worker/repository/PageRepo.ts`, add `pageIdsMissingEmbeddings` and extend `getStats`:

```ts
  async pageIdsMissingEmbeddings(): Promise<string[]> {
    const [readyPages, chunks] = await Promise.all([
      this.database.pages.where("status").equals("ready").toArray(),
      this.database.chunks.toArray(),
    ]);

    const embeddedPageIds = new Set<string>();
    for (const chunk of chunks) {
      if (chunk.embedding !== undefined) {
        embeddedPageIds.add(chunk.pageId);
      }
    }

    return readyPages.map((page) => page.id).filter((id) => !embeddedPageIds.has(id));
  }

  async getStats(): Promise<{
    pageCount: number;
    totalTextBytes: number;
    pagesMissingEmbeddings: number;
  }> {
    const pages = await this.database.pages.toArray();
    const totalTextBytes = pages.reduce((sum, p) => sum + p.fullText.length, 0);
    const pagesMissingEmbeddings = (await this.pageIdsMissingEmbeddings()).length;

    return { pageCount: pages.length, totalTextBytes, pagesMissingEmbeddings };
  }
```

- [ ] **Step 4: Run the repo tests**

```bash
pnpm test src/worker/repository/PageRepo.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing CaptureService test**

Append to `src/worker/services/CaptureService.test.ts` (inside the `describe("CaptureService", ...)` block):

```ts
  it("reindexes pages sequentially and reports progress", async () => {
    const processed: string[] = [];
    const reader: PageReader = {
      getById: vi.fn().mockResolvedValue(pendingPage),
      updatePage: vi.fn().mockResolvedValue(undefined),
    };
    const tagger: PageTagger = { summarizeAndTag: vi.fn().mockResolvedValue(taggingResult) };
    const chunkWriter = mockChunkWriter();
    const embedder = mockEmbedder();
    const service = new CaptureService(
      { upsertCapturedPage: vi.fn() },
      { extract: vi.fn() },
      reader,
      tagger,
      chunkWriter,
      embedder,
    );
    // Spy processPage to record order without re-tagging twice per id.
    const original = service.processPage.bind(service);
    vi.spyOn(service, "processPage").mockImplementation(async (id, key) => {
      processed.push(id);
      return original(id, key);
    });

    const progress: Array<[number, number]> = [];
    await service.reindexPages(["a", "b", "c"], "sk-test", (done, total) =>
      progress.push([done, total]),
    );

    expect(processed).toEqual(["a", "b", "c"]);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
```

- [ ] **Step 6: Run to verify it fails**

```bash
pnpm test src/worker/services/CaptureService.test.ts
```

Expected: FAIL — `reindexPages` does not exist.

- [ ] **Step 7: Add `reindexPages` to CaptureService**

In `src/worker/services/CaptureService.ts`, add to the `CaptureService` class:

```ts
  async reindexPages(
    pageIds: string[],
    apiKey: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<void> {
    let done = 0;
    for (const id of pageIds) {
      await this.processPage(id, apiKey);
      done += 1;
      onProgress(done, pageIds.length);
    }
  }
```

- [ ] **Step 8: Run the CaptureService tests**

```bash
pnpm test src/worker/services/CaptureService.test.ts
```

Expected: PASS.

- [ ] **Step 9: Write the failing worker handler tests**

In `src/worker/index.test.ts`, add:

```ts
  it("starts a reindex and reports the total when a key is set", async () => {
    const deps = makeDeps({ apiKey: "sk-test" });
    deps.pageRepo.pageIdsMissingEmbeddings = vi.fn().mockResolvedValue(["a", "b"]);

    await expect(handleRequest({ type: "library.reindex" }, deps)).resolves.toEqual({
      type: "library.reindexStarted",
      payload: { total: 2 },
    });

    await vi.waitFor(() => {
      expect(deps.captureService.reindexPages).toHaveBeenCalledWith(
        ["a", "b"],
        "sk-test",
        expect.any(Function),
      );
    });
  });

  it("refuses to reindex without an API key", async () => {
    const deps = makeDeps({ apiKey: null });

    await expect(handleRequest({ type: "library.reindex" }, deps)).resolves.toEqual({
      type: "error",
      payload: { message: "No API key set" },
    });
    expect(deps.captureService.reindexPages).not.toHaveBeenCalled();
  });
```

- [ ] **Step 10: Add the `library.reindex` handler**

In `src/worker/index.ts`, add a case before `default:`:

```ts
    case "library.reindex": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      if (!apiKey) {
        return { type: "error", payload: { message: "No API key set" } };
      }

      const pageIds = await deps.pageRepo.pageIdsMissingEmbeddings();

      void deps.captureService
        .reindexPages(pageIds, apiKey, (done, total) => {
          deps.retrievalService.invalidate();
          deps.broadcast({ type: "library.reindexProgress", payload: { done, total } });
        })
        .catch((error) => {
          console.error("[DevRecall] reindex error:", error);
        });

      return { type: "library.reindexStarted", payload: { total: pageIds.length } };
    }
```

- [ ] **Step 11: Run worker tests, full typecheck (the Task 2 breakage clears here)**

```bash
pnpm test src/worker/index.test.ts
pnpm typecheck
```

Expected: PASS — `getStats` now produces `pagesMissingEmbeddings`, so the contract from Task 2 is satisfied.

- [ ] **Step 12: Commit**

```bash
git add src/worker/repository/PageRepo.ts src/worker/repository/PageRepo.test.ts src/worker/services/CaptureService.ts src/worker/services/CaptureService.test.ts src/worker/index.ts src/worker/index.test.ts
git commit -m "feat: re-index library for pages missing embeddings"
```

---

## Task 6: Keyboard shortcut

**Files:**

- Modify: `manifest.config.ts`
- Modify: `src/worker/index.ts`

The shortcut opens the side panel synchronously inside the `chrome.commands` event (the same user-gesture rule as the popup button — no `await` before `sidePanel.open`). User-rebindable at `chrome://extensions/shortcuts`; if the default combo is taken, it simply stays unbound (parent spec §7.2). This is verified manually (parent spec §9), not unit-tested.

- [ ] **Step 1: Add the `commands` entry to the manifest**

In `manifest.config.ts`, add a `commands` key to the manifest object (e.g. after `permissions`):

```ts
  commands: {
    "open-side-panel": {
      suggested_key: { default: "Ctrl+Shift+K", mac: "Command+Shift+K" },
      description: "Open the DevRecall side panel",
    },
  },
```

- [ ] **Step 2: Add the command listener to the worker**

In `src/worker/index.ts`, append after the existing `chrome.runtime.onMessage` listener block:

```ts
if (typeof chrome !== "undefined" && chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "open-side-panel" && chrome.sidePanel?.open) {
      // Synchronous within the command gesture — no await before open().
      void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    }
  });
}
```

- [ ] **Step 3: Typecheck and build**

```bash
pnpm typecheck
pnpm build
```

Expected: PASS, and `dist/manifest.json` contains the `commands` block (`grep -A4 '"commands"' dist/manifest.json`).

- [ ] **Step 4: Commit**

```bash
git add manifest.config.ts src/worker/index.ts
git commit -m "feat: keyboard shortcut to open the side panel"
```

---

## Task 7: Side panel live refresh and delete

**Files:**

- Modify: `src/ui/components/PageCard.tsx`
- Modify: `src/sidepanel/App.tsx`
- Test: `src/sidepanel/App.test.tsx`

The side panel subscribes to `WorkerBroadcast`s and reconciles the **library list** in place (`page.updated` → upsert at top, `page.removed` → drop). Search results are a query snapshot and are not disturbed (parent spec §7.1). The expanded card gains a Delete action wired to `page.delete`; the removal lands via the `page.removed` broadcast.

- [ ] **Step 1: Add `onDelete` to PageCard**

In `src/ui/components/PageCard.tsx`, add the optional prop and a Delete button in the expanded footer. Update the props type:

```ts
type PageCardProps = {
  page: PageListItem;
  onDelete?: (id: string) => void;
};

export function PageCard({ page, onDelete }: PageCardProps) {
```

Replace the expanded footer `<div className="flex items-center justify-between">…</div>` (the row containing the `Open →` link) with:

```tsx
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">
              {page.sourceType.replace(/_/g, " ")} · {savedDate}
            </span>
            <div className="flex items-center gap-3">
              {onDelete && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(page.id);
                  }}
                  className="text-xs font-medium text-red-600 hover:underline"
                >
                  Delete
                </button>
              )}
              <a
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-accent hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                Open →
              </a>
            </div>
          </div>
```

- [ ] **Step 2: Write the failing side-panel tests**

In `src/sidepanel/App.test.tsx`, extend imports and add tests:

```ts
import { act, render, screen } from "@testing-library/react";
import type { WorkerBroadcast } from "../shared/messages";

function makeSubscribe() {
  let handler: ((message: WorkerBroadcast) => void) | null = null;
  const subscribe = (h: (message: WorkerBroadcast) => void) => {
    handler = h;
    return () => {
      handler = null;
    };
  };
  const emit = async (message: WorkerBroadcast) => {
    await act(async () => {
      handler?.(message);
    });
  };
  return { subscribe, emit };
}

const newPage: PageListItem = {
  id: "01HZ1111111111111111111111",
  url: "https://react.dev/learn",
  title: "Learn React",
  domain: "react.dev",
  sourceType: "official_docs",
  summary: "React docs",
  topics: [],
  technologies: [],
  savedAt: 200,
  status: "ready",
};

describe("Side panel live refresh", () => {
  it("inserts a card when a page.updated broadcast arrives", async () => {
    const { subscribe, emit } = makeSubscribe();
    render(<App listPages={vi.fn().mockResolvedValue([])} runSearch={vi.fn()} subscribe={subscribe} />);

    await screen.findByText("No saved pages yet");
    await emit({ type: "page.updated", payload: { page: newPage } });

    expect(await screen.findByRole("heading", { name: "Learn React" })).toBeInTheDocument();
  });

  it("removes a card when a page.removed broadcast arrives", async () => {
    const { subscribe, emit } = makeSubscribe();
    render(<App listPages={vi.fn().mockResolvedValue(pages)} runSearch={vi.fn()} subscribe={subscribe} />);

    await screen.findByRole("heading", { name: "Horizontal Pod Autoscaling" });
    await emit({ type: "page.removed", payload: { id: pages[0].id } });

    expect(screen.queryByRole("heading", { name: "Horizontal Pod Autoscaling" })).toBeNull();
  });

  it("deletes a page from the expanded card", async () => {
    const user = userEvent.setup();
    const deletePage = vi.fn().mockResolvedValue(undefined);
    render(
      <App
        listPages={vi.fn().mockResolvedValue(pages)}
        runSearch={vi.fn()}
        deletePage={deletePage}
        subscribe={makeSubscribe().subscribe}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Horizontal Pod Autoscaling/ }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(deletePage).toHaveBeenCalledWith(pages[0].id);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm test src/sidepanel/App.test.tsx
```

Expected: FAIL — `App` accepts no `subscribe`/`deletePage` props and the cards have no Delete button.

- [ ] **Step 4: Wire the App**

Replace the contents of `src/sidepanel/App.tsx` with:

```tsx
import { useCallback, useEffect, useState } from "react";

import type { DevRecallRequest, DevRecallResponse, WorkerBroadcast } from "../shared/messages";
import type { PageHit, PageListItem } from "../shared/types";
import { PageCard, SearchResultCard, SurfaceShell } from "../ui/components";

const filters = ["All", "Docs", "SO", "GH"] as const;

type AppProps = {
  listPages?: () => Promise<PageListItem[]>;
  runSearch?: (query: string) => Promise<PageHit[]>;
  deletePage?: (id: string) => Promise<void>;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
};

async function defaultListPages(): Promise<PageListItem[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }

  try {
    const request: DevRecallRequest = { type: "page.list", payload: { limit: 50 } };
    const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;

    if (response.type !== "page.listed") {
      return [];
    }

    return response.payload.pages ?? [];
  } catch {
    return [];
  }
}

async function defaultRunSearch(query: string): Promise<PageHit[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }

  try {
    const request: DevRecallRequest = { type: "search.run", payload: { query } };
    const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;

    if (response.type !== "search.results") {
      return [];
    }

    return response.payload.hits ?? [];
  } catch {
    return [];
  }
}

async function defaultDeletePage(id: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return;
  }

  const request: DevRecallRequest = { type: "page.delete", payload: { id } };
  await chrome.runtime.sendMessage(request);
}

function defaultSubscribe(handler: (message: WorkerBroadcast) => void): () => void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
    return () => {};
  }

  const listener = (message: unknown) => {
    handler(message as WorkerBroadcast);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function App({
  listPages = defaultListPages,
  runSearch = defaultRunSearch,
  deletePage = defaultDeletePage,
  subscribe = defaultSubscribe,
}: AppProps) {
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hits, setHits] = useState<PageHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadPages() {
      setLoading(true);
      try {
        const nextPages = await listPages();
        if (!cancelled) {
          setPages(nextPages);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setPages([]);
          setLoading(false);
        }
      }
    }

    void loadPages();

    return () => {
      cancelled = true;
    };
  }, [listPages]);

  useEffect(() => {
    const handle = setTimeout(() => setSubmittedQuery(query.trim()), 200);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (submittedQuery.length === 0) {
      setHits([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    void runSearch(submittedQuery).then((nextHits) => {
      if (!cancelled) {
        setHits(nextHits);
        setSearching(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [submittedQuery, runSearch]);

  // Live refresh: reconcile the library list in place from worker broadcasts.
  // Search results are a query snapshot and are intentionally left untouched.
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === "page.updated") {
        setPages((prev) => {
          const index = prev.findIndex((p) => p.id === message.payload.page.id);
          if (index === -1) {
            return [message.payload.page, ...prev];
          }
          const next = prev.slice();
          next[index] = message.payload.page;
          return next;
        });
      } else if (message.type === "page.removed") {
        setPages((prev) => prev.filter((p) => p.id !== message.payload.id));
      }
    });

    return unsubscribe;
  }, [subscribe]);

  const handleDelete = useCallback(
    (id: string) => {
      void deletePage(id);
    },
    [deletePage],
  );

  const isSearching = submittedQuery.length > 0;

  return (
    <SurfaceShell
      title="DevRecall"
      actions={
        <button
          type="button"
          aria-label="Settings"
          className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600"
          onClick={() => chrome.runtime.openOptionsPage()}
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
          value={query}
          onChange={(event) => setQuery(event.target.value)}
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

        {isSearching ? (
          searching ? (
            <p className="text-sm text-slate-500">Searching...</p>
          ) : hits.length === 0 ? (
            <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
              <h2 className="text-sm font-semibold text-slate-900">No matches for your search</h2>
              <p className="mt-2 text-sm text-slate-500">Try different keywords.</p>
            </section>
          ) : (
            <div className="flex flex-col gap-3">
              {hits.map((hit) => (
                <SearchResultCard key={hit.page.id} hit={hit} />
              ))}
            </div>
          )
        ) : loading ? (
          <p className="text-sm text-slate-500">Loading library...</p>
        ) : pages.length === 0 ? (
          <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
            <h2 className="text-sm font-semibold text-slate-900">No saved pages yet</h2>
            <p className="mt-2 text-sm text-slate-500">Saved pages will appear here.</p>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {pages.map((page) => (
              <PageCard key={page.id} page={page} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}
```

- [ ] **Step 5: Run the side-panel tests**

```bash
pnpm test src/sidepanel/App.test.tsx
```

Expected: PASS — the three existing tests plus the three live-refresh/delete tests.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/PageCard.tsx src/sidepanel/App.tsx src/sidepanel/App.test.tsx
git commit -m "feat: live side-panel refresh and single-page delete"
```

---

## Task 8: "Matched by meaning" badge

**Files:**

- Modify: `src/ui/components/SearchResultCard.tsx`
- Test: `src/sidepanel/App.test.tsx`

A vector-only hit (`matchReason: "vector"`) has no literal term overlap and renders no `<mark>` (M5c); the badge is what tells the user it was found by meaning. Map the reason to a friendly label and color (parent spec §6.5).

- [ ] **Step 1: Write the failing test**

In `src/sidepanel/App.test.tsx`, add a vector-hit fixture and a test:

```ts
const vectorHit = {
  page: pages[0],
  bestChunk: {
    text: "The HorizontalPodAutoscaler automatically scales workloads.",
    ordinal: 0,
    highlightedHtml: "The HorizontalPodAutoscaler automatically scales workloads.",
  },
  scores: { keyword: null, vector: 0.83, fused: 0.016 },
  matchReason: "vector",
} satisfies PageHit;

it("labels a vector-only hit as matched by meaning", async () => {
  const user = userEvent.setup();
  const runSearch = vi.fn().mockResolvedValue([vectorHit]);

  render(<App listPages={vi.fn().mockResolvedValue([])} runSearch={runSearch} subscribe={makeSubscribe().subscribe} />);

  await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "elastic scaling");

  expect(await screen.findByText("matched by meaning")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test src/sidepanel/App.test.tsx
```

Expected: FAIL — the card renders the raw `"vector"` string, not `"matched by meaning"`.

- [ ] **Step 3: Map reasons to labels in SearchResultCard**

Replace the badge `<span>` in `src/ui/components/SearchResultCard.tsx` (currently rendering `{matchReason}`) with a labeled, color-coded badge:

```tsx
import type { PageHit, SearchMatchReason } from "../../shared/types";

type SearchResultCardProps = {
  hit: PageHit;
};

const BADGE: Record<SearchMatchReason, { label: string; className: string }> = {
  keyword: { label: "keyword", className: "bg-emerald-100 text-emerald-700" },
  vector: { label: "matched by meaning", className: "bg-violet-100 text-violet-700" },
  both: { label: "keyword + meaning", className: "bg-sky-100 text-sky-700" },
};

export function SearchResultCard({ hit }: SearchResultCardProps) {
  const { page, bestChunk, matchReason } = hit;
  const badge = BADGE[matchReason];

  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          <a href={page.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {page.title}
          </a>
        </h2>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-500">{page.domain}</p>

      <p
        className="mt-2 text-sm text-slate-600 [&_mark]:rounded [&_mark]:bg-amber-200 [&_mark]:px-0.5 [&_mark]:text-slate-900"
        dangerouslySetInnerHTML={{ __html: bestChunk.highlightedHtml }}
      />

      {page.topics.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {page.topics.map((topic) => (
            <span
              key={topic}
              className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
            >
              {topic}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
```

> The existing "runs a keyword search and shows highlighted results" test asserts `getByText("keyword")`, which still matches the `keyword` badge label.

- [ ] **Step 4: Run the side-panel tests**

```bash
pnpm test src/sidepanel/App.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/SearchResultCard.tsx src/sidepanel/App.test.tsx
git commit -m "feat: matched-by-meaning badge for vector-only hits"
```

---

## Task 9: Options re-index control

**Files:**

- Modify: `src/options/Options.tsx`
- Test: `src/options/Options.test.tsx`

Add a "Re-index library" button: disabled without an API key or when nothing is missing, showing the missing count when idle and live progress while running. Progress arrives via the `library.reindexProgress` broadcast.

- [ ] **Step 1: Write the failing tests**

In `src/options/Options.test.tsx`, add tests (the existing `renderOptions` helper passes only `loadStatus`/`saveApiKey`/`testConnection`, so inject the new props explicitly):

```ts
import type { WorkerBroadcast } from "../shared/messages";

function makeSubscribe() {
  let handler: ((m: WorkerBroadcast) => void) | null = null;
  return {
    subscribe: (h: (m: WorkerBroadcast) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    emit: async (m: WorkerBroadcast) => {
      await act(async () => {
        handler?.(m);
      });
    },
  };
}

it("disables re-index when no pages are missing embeddings", async () => {
  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    loadStorageStats: vi
      .fn()
      .mockResolvedValue({ pageCount: 3, totalTextBytes: 100, pagesMissingEmbeddings: 0 }),
  });

  const button = await screen.findByRole("button", { name: /Re-index library/ });
  expect(button).toBeDisabled();
});

it("starts a re-index and shows live progress", async () => {
  const { subscribe, emit } = makeSubscribe();
  const startReindex = vi.fn().mockResolvedValue({ total: 2 });

  renderOptions({
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    loadStorageStats: vi
      .fn()
      .mockResolvedValue({ pageCount: 2, totalTextBytes: 100, pagesMissingEmbeddings: 2 }),
    startReindex,
    subscribe,
  });

  const user = userEvent.setup();
  const button = await screen.findByRole("button", { name: /Re-index library \(2\)/ });
  await user.click(button);

  expect(startReindex).toHaveBeenCalled();
  await emit({ type: "library.reindexProgress", payload: { done: 1, total: 2 } });
  expect(await screen.findByText(/Re-indexing 1\s*\/\s*2/)).toBeInTheDocument();
});
```

Also add `act` to the testing-library import: `import { act, render, screen } from "@testing-library/react";`

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test src/options/Options.test.tsx
```

Expected: FAIL — no re-index button, no `startReindex`/`subscribe`/`loadStorageStats` plumbing for the count/progress.

- [ ] **Step 3: Add the re-index control to Options**

Edit `src/options/Options.tsx`:

(a) Extend imports and types at the top:

```ts
import { useEffect, useState } from "react";
import { SurfaceShell } from "../ui/components";
import type { DevRecallRequest, DevRecallResponse, WorkerBroadcast } from "../shared/messages";

type StatusResult = { hasApiKey: boolean };
type TestResult = { success: boolean; message: string };
type StorageStats = { pageCount: number; totalTextBytes: number; pagesMissingEmbeddings: number };

type OptionsProps = {
  loadStatus?: () => Promise<StatusResult>;
  saveApiKey?: (apiKey: string) => Promise<void>;
  testConnection?: () => Promise<TestResult>;
  loadStorageStats?: () => Promise<StorageStats>;
  startReindex?: () => Promise<{ total: number }>;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
};
```

(b) Add the default implementations near the other defaults:

```ts
const defaultStartReindex = async (): Promise<{ total: number }> => {
  const request: DevRecallRequest = { type: "library.reindex" };
  const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;
  return response.type === "library.reindexStarted" ? response.payload : { total: 0 };
};

const defaultSubscribe = (handler: (message: WorkerBroadcast) => void): (() => void) => {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
    return () => {};
  }
  const listener = (message: unknown) => handler(message as WorkerBroadcast);
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
};
```

(c) Add the new props to the component signature and new state/effects/handler:

```ts
export function Options({
  loadStatus = defaultLoadStatus,
  saveApiKey = defaultSaveApiKey,
  testConnection = defaultTestConnection,
  loadStorageStats = defaultLoadStorageStats,
  startReindex = defaultStartReindex,
  subscribe = defaultSubscribe,
}: OptionsProps) {
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
```

After the existing effects, add a broadcast subscription that tracks progress:

```ts
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === "library.reindexProgress") {
        setProgress(message.payload);
        if (message.payload.done >= message.payload.total) {
          setReindexing(false);
          loadStorageStats().then(setStorageStats).catch(() => {});
        }
      }
    });
    return unsubscribe;
  }, [subscribe, loadStorageStats]);
```

Add the handler:

```ts
  const handleReindex = async () => {
    setReindexing(true);
    setProgress({ done: 0, total: 0 });
    try {
      const { total } = await startReindex();
      setProgress({ done: 0, total });
      if (total === 0) {
        setReindexing(false);
      }
    } catch {
      setReindexing(false);
    }
  };
```

(d) Render the control inside the `Storage` section (after the existing storage `<p>`):

```tsx
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Storage</h2>
          <p className="mt-2 text-sm text-slate-500">
            {storageStats == null
              ? "Loading..."
              : `${storageStats.pageCount} ${storageStats.pageCount === 1 ? "page" : "pages"}, ${(storageStats.totalTextBytes / 1_048_576).toFixed(2)} MB`}
          </p>

          <button
            type="button"
            onClick={handleReindex}
            disabled={
              !keySaved || reindexing || (storageStats?.pagesMissingEmbeddings ?? 0) === 0
            }
            className="mt-3 rounded-md bg-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {reindexing && progress
              ? `Re-indexing ${progress.done} / ${progress.total}...`
              : `Re-index library${
                  storageStats && storageStats.pagesMissingEmbeddings > 0
                    ? ` (${storageStats.pagesMissingEmbeddings})`
                    : ""
                }`}
          </button>
          {!keySaved && (
            <p className="mt-1 text-xs text-amber-600">Set an API key to re-index.</p>
          )}
        </section>
```

- [ ] **Step 4: Run the Options tests**

```bash
pnpm test src/options/Options.test.tsx
```

Expected: PASS — new tests plus the existing five (which inject only the original props; the new defaults are guarded for the no-`chrome` test environment).

- [ ] **Step 5: Commit**

```bash
git add src/options/Options.tsx src/options/Options.test.tsx
git commit -m "feat: Options re-index control with live progress"
```

---

## Task 10: Final M5d verification and manual checklist

**Files:** none (verification only)

- [ ] **Step 1: Full suite, typecheck, lint, build**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all PASS. Confirm `dist/manifest.json` includes the `commands` block.

- [ ] **Step 2: Coverage on new/changed worker + lib code**

```bash
pnpm test -- --coverage
```

Expected: ≥80% on `src/worker/services/**`, `src/worker/repository/**`, and the M5a `src/lib/**` modules (parent success criterion #9).

- [ ] **Step 3: Manual Chrome checklist (parent spec §9)**

Load the unpacked `dist/`, set a valid OpenAI key, then verify each:

1. **Live `pending → ready`:** open the side panel, save a page from the popup → its card appears as "Processing…" then flips to ready in place, no reload.
2. **Keyboard shortcut:** from any tab press `Ctrl/Cmd+Shift+K` → the side panel opens. (If unbound because the combo was taken, assign one at `chrome://extensions/shortcuts`.)
3. **Chinese query:** save an English technical page; search a related Chinese query → results appear (vector arm cross-lingual and/or CJK-bigram keyword arm).
4. **Matched by meaning:** search wording that shares no literal terms with a saved page but matches its meaning → that page shows the violet "matched by meaning" badge with no highlight.
5. **Delete:** expand a library card, click Delete → the card disappears live and search no longer returns it.
6. **Re-index:** load a page saved before M5b (or clear embeddings), open Options → "Re-index library (N)" is enabled; click it → it shows "Re-indexing X / N…" and settles; afterward that page carries vectors (its searches can match by meaning).
7. **Five hybrid queries:** run the 5 hand-built queries from the parent spec and confirm hybrid out-ranks keyword-only for each, including at least one vector-only hit (parent success criterion #3).

- [ ] **Step 4: Inspect the diff scope**

```bash
git diff --stat main..HEAD
```

Expected: M5a–M5c files (merged) plus the M5d files listed in this plan's File Structure and the four M5 plan docs.

- [ ] **Step 5: Final commit (if anything is unstaged)**

```bash
git status --short
git commit -am "feat: complete M5 embeddings + hybrid retrieval milestone" || true
```

---

## Self-Review Notes

- **Spec coverage.** M5d delivers success criteria #5 (live `pending → ready`, Task 3 + 7), #6 (keyboard shortcut, Task 6), #7 (atomic delete reflected live, Tasks 4 + 7), and #8 (re-index, Tasks 5 + 9), plus the §6.6 caching (Task 1) and the §6.5 badge (Task 8). Criterion #3 (5 hybrid queries) and the Chinese-query check are in the manual checklist (Task 10), as the parent spec's §9 places them under Manual/E2E with real embeddings.
- **Cache invalidation is an in-process call, not a self-broadcast.** A worker cannot receive its own `chrome.runtime.sendMessage`, so the retriever can't "listen" for `page.updated`/`page.removed`. Instead every mutation site (`page.save`, the `processPage` continuation, `page.delete`, each reindex step) calls `deps.retrievalService.invalidate()` right next to `deps.broadcast(...)`. Same instant, two audiences: `invalidate()` for the in-worker cache, the broadcast for the UI contexts.
- **Live refresh updates the library list only.** The `onMessage` reducer touches `pages` state, never `hits`. Search results are a query snapshot (parent spec §7.1); a background `page.updated` during an active search updates the underlying library but won't reorder the visible result list until the next query. The delete card vanishes via the `page.removed` broadcast the worker sends to *all* contexts including the initiating panel — so no optimistic local removal is needed, keeping one source of truth.
- **Atomic mutations.** Delete (`deleteWithChunks`) and the embed upgrade (`commitProcessedPage`, M5b) each wrap both tables in one `rw` transaction — no orphan chunks, no half-states. Re-index is *resumable*: each page is its own `processPage` transaction, so a killed worker leaves done pages embedded and the rest keyword-only; re-clicking resumes from `pageIdsMissingEmbeddings`.
- **Testability boundaries.** UI broadcast wiring is injected via a `subscribe` prop (mirroring the existing `listPages`/`runSearch` pattern), so live-refresh and progress are unit-tested without a real `chrome`. The `chrome.commands` shortcut is the one piece left to the manual checklist — it is thin glue (`sidePanel.open` inside the command event) that can't run in jsdom and has no logic worth a brittle global-`chrome` stub.
- **Stat field placement.** `pagesMissingEmbeddings` rides on the existing `storage.stats` the Options page already fetches, rather than a new request — Options needs the count exactly where it already reads storage stats. The message-contract change (Task 2) lands one task before its producer (`getStats`, Task 5), so a strict in-order run is briefly red on typecheck between them; this is called out in Task 2 Step 5 and clears in Task 5.
- **Type consistency.** `WorkerBroadcast` is one union consumed identically by the worker (`broadcast`), the side panel, and Options. `SearchPort.invalidate`, `CapturePort.reindexPages`, and `PageListPort.{deleteWithChunks, pageIdsMissingEmbeddings, getStats}` are mirrored exactly between the production classes and the `index.test.ts` mock deps. The `SearchResultCard` `BADGE` map is keyed by `SearchMatchReason`, so adding a future reason is a compile error until the label is supplied.
- **Security.** `highlightedHtml` is still built only from escaped chunk text + worker-added `<mark>` (M4/M5c); the badge label is static React text. Delete has no confirmation dialog — a deliberate simplicity choice for the portfolio scope; a confirm step is a trivial M6 follow-up if desired.
```
