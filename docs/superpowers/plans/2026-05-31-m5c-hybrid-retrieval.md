# M5c — Hybrid Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `RetrievalService` into a hybrid retriever — run a keyword (BM25) arm and a vector (cosine) arm in parallel, fuse them with Reciprocal Rank Fusion, and return the best chunk per page tagged `keyword` / `vector` / `both`, with a vector-only hit carrying no `<mark>` (the "matched by meaning" case).

**Architecture:** Third of four M5 plans (M5a ✅ → M5b ✅ → **M5c** → M5d). M5c composes the M5a primitives (`cosineTopK`, `reciprocalRankFusion`, CJK `bm25`) and the M5b embedder (`Embedder.embed` for the query vector) inside `RetrievalService.search`. It reshapes `PageHit` from a single `score` to `{ keyword, vector, fused }` plus a widened `matchReason`. Search still reads chunks **per-query** from IndexedDB (exactly as M4 does) — the in-memory chunk cache and broadcast-driven invalidation are deferred to **M5d**, where the broadcasts that would invalidate a cache actually exist. With no API key, the vector arm is skipped and search degrades to keyword-only, preserving M4's "works without a key" property.

**Tech Stack:** TypeScript strict mode, Vitest, Dexie. Composes `lib/vector.ts`, `lib/rrf.ts`, `lib/bm25.ts` (M5a) and the `Embedder` port (M5b).

**Parent spec:** [`docs/superpowers/specs/2026-05-31-m5-hybrid-retrieval-design.md`](../specs/2026-05-31-m5-hybrid-retrieval-design.md) — §4.4 (PageHit.scores), §6 (retrieval pipeline), §6.5 (highlighting).

**Depends on:** M5a (`lib/vector.ts`, `lib/rrf.ts`, CJK `lib/bm25.ts`) and M5b (`Embedder` port, embedded chunks) merged and green.

---

## Scope

M5c implements hybrid retrieval and its contract change:

- `PageHit.score: number` → `PageHit.scores: { keyword: number | null; vector: number | null; fused: number }`. `SearchMatchReason` widens to `"keyword" | "vector" | "both"`.
- `RetrievalService.search(query, { topK, apiKey })`: keyword arm (BM25 over all chunk texts) ∪ vector arm (query embedding → `cosineTopK` over embedded chunks), fused with RRF(k=60), best fused chunk per page, top-K, `matchReason` from arm membership, `<mark>` only for keyword/both hits.
- Worker `search.run` fetches the stored API key and passes it to `search`, so the vector arm runs in production; a shared `OpenAIProvider` is wired as the retriever's embedder.

Out of scope:

- In-memory chunk array + derived `avgdl` cache, LRU query cache, broadcast-driven invalidation → **M5d** (with the `page.updated`/`page.removed` broadcasts that invalidate them).
- The "matched by meaning" badge UI polish (M5c leaves `SearchResultCard` rendering the raw `matchReason` string) → **M5d**.
- Delete, re-index, keyboard shortcut, live refresh → **M5d**.

Baseline before plan creation:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all pass, with M5a + M5b merged (token chunking, vector/rrf libs, CJK bm25, embeddings, `processPage` embeds).

## File Structure

- Modify `src/shared/types.ts` — reshape `PageHit`, widen `SearchMatchReason`.
- Modify `src/worker/services/RetrievalService.ts` and `RetrievalService.test.ts` — hybrid search.
- Modify `src/worker/index.ts` and `src/worker/index.test.ts` — pass API key into `search`; share the embedder; fix the `searchHit` fixture.
- Modify `src/sidepanel/App.test.tsx` — fix the `hits` fixture to the new `PageHit` shape (`App.tsx` and `SearchResultCard.tsx` need no code change; they don't read `score`).

---

## Task 1: Reshape PageHit and rewrite RetrievalService as hybrid

**Files:**

- Modify: `src/shared/types.ts:78-89`
- Modify: `src/worker/services/RetrievalService.ts`
- Test: `src/worker/services/RetrievalService.test.ts`
- Modify: `src/worker/index.test.ts:41-50` (fixture only)
- Modify: `src/sidepanel/App.test.tsx:23-34` (fixture only)

This single task carries the breaking `PageHit` change and every ripple it forces, so the full suite is green at the task boundary. The worker handler is **not** touched here (it still calls `search(query, { topK })`, which compiles because `apiKey` is optional) — wiring the key through is Task 2.

- [ ] **Step 1: Reshape the shared types**

Replace `SearchMatchReason` and `PageHit` in `src/shared/types.ts` (lines 78–89) with:

```ts
export type SearchMatchReason = "keyword" | "vector" | "both";

export type PageHit = {
  page: PageListItem;
  bestChunk: {
    text: string;
    ordinal: number;
    highlightedHtml: string; // matched terms wrapped in <mark>, HTML-escaped
  };
  scores: {
    keyword: number | null; // BM25 score, or null if the keyword arm missed this chunk
    vector: number | null; // cosine score, or null if the vector arm missed this chunk
    fused: number; // RRF fused score (the ranking key)
  };
  matchReason: SearchMatchReason;
};
```

- [ ] **Step 2: Write the failing RetrievalService tests**

Replace the entire body of `src/worker/services/RetrievalService.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";

import type { ChunkRecord, PageRecord } from "../../shared/types";
import type { Embedder } from "../llm/OpenAIProvider";
import { RetrievalService, type ChunkSource, type PageSource } from "./RetrievalService";

function chunk(
  id: string,
  pageId: string,
  ordinal: number,
  text: string,
  embedding?: number[],
): ChunkRecord {
  return {
    id,
    pageId,
    ordinal,
    text,
    ...(embedding ? { embedding: Float32Array.from(embedding) } : {}),
    schemaVersion: 1,
  };
}

function page(id: string, title: string, domain: string): PageRecord {
  return {
    id,
    url: `https://${domain}/${id}`,
    urlHash: id.padEnd(64, "0"),
    title,
    domain,
    sourceType: "official_docs",
    summary: "",
    topics: ["kubernetes"],
    technologies: ["Kubernetes"],
    intent: "reference",
    fullText: "",
    savedAt: 100,
    visitedAt: 100,
    readingTimeMs: 1000,
    saveMode: "manual",
    status: "ready",
    schemaVersion: 1,
  };
}

const pages = new Map<string, PageRecord>([
  ["p1", page("p1", "Horizontal Pod Autoscaling", "kubernetes.io")],
  ["p2", page("p2", "React hydration", "github.com")],
]);

// Keyword-only chunks (no embeddings), as M4 produced them.
const keywordChunks = [
  chunk("c1", "p1", 0, "horizontal pod autoscaler automatically scales pods"),
  chunk("c2", "p2", 0, "react hydration mismatch during rendering"),
  chunk("c3", "p1", 1, "the autoscaler watches metrics"),
];

// Chunks with hand-crafted unit embeddings for the vector arm.
const vectorChunks = [
  chunk("c1", "p1", 0, "horizontal pod autoscaler scales pods", [1, 0]),
  chunk("c2", "p2", 0, "react server side rendering hydration", [0, 1]),
];

function fakeEmbedder(queryVectors: Record<string, number[]>): Embedder {
  return {
    embeddingModel: "fake",
    embed: vi
      .fn()
      .mockImplementation(async (text: string) => Float32Array.from(queryVectors[text] ?? [0, 0])),
    embedBatch: vi.fn(),
  };
}

function makeService(
  testChunks: ChunkRecord[] = keywordChunks,
  embedder: Embedder = fakeEmbedder({}),
): RetrievalService {
  const chunkSource: ChunkSource = { allChunks: vi.fn().mockResolvedValue(testChunks) };
  const pageSource: PageSource = {
    getById: vi.fn().mockImplementation((id: string) => pages.get(id)),
  };
  return new RetrievalService(chunkSource, pageSource, embedder);
}

describe("RetrievalService", () => {
  it("returns an empty array for a blank query", async () => {
    await expect(makeService().search("   ")).resolves.toEqual([]);
  });

  it("returns the best-matching page with a highlighted chunk (keyword arm)", async () => {
    const hits = await makeService().search("autoscale pods");

    expect(hits).toHaveLength(1);
    expect(hits[0].page.id).toBe("p1");
    expect(hits[0].matchReason).toBe("keyword");
    expect(hits[0].scores.keyword).toBeGreaterThan(0);
    expect(hits[0].scores.vector).toBeNull();
    expect(hits[0].scores.fused).toBeGreaterThan(0);
    expect(hits[0].bestChunk.highlightedHtml).toContain("<mark>pods</mark>");
  });

  it("keeps only the highest-scoring chunk per page", async () => {
    const hits = await makeService().search("autoscaler pods");

    expect(hits).toHaveLength(1);
    expect(hits[0].bestChunk.ordinal).toBe(0);
  });

  it("honors the topK option", async () => {
    const hits = await makeService().search("autoscaler hydration", { topK: 1 });

    expect(hits).toHaveLength(1);
  });

  it("does not call the embedder without an API key", async () => {
    const embedder = fakeEmbedder({});

    await makeService(vectorChunks, embedder).search("autoscaler pods");

    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it("surfaces a vector-only hit that keyword search misses (matched by meaning)", async () => {
    const embedder = fakeEmbedder({ "elastic scaling of containers": [1, 0] });

    // Keyword-only (no key) finds nothing — none of these terms appear in any chunk.
    const keywordOnly = await makeService(vectorChunks, embedder).search(
      "elastic scaling of containers",
    );
    expect(keywordOnly).toEqual([]);

    // Hybrid (with key) surfaces p1 by meaning, with no literal term overlap.
    const hybrid = await makeService(vectorChunks, embedder).search(
      "elastic scaling of containers",
      { apiKey: "sk-test" },
    );

    expect(hybrid[0].page.id).toBe("p1");
    expect(hybrid[0].matchReason).toBe("vector");
    expect(hybrid[0].scores.keyword).toBeNull();
    expect(hybrid[0].scores.vector).toBeGreaterThan(0.9);
    expect(hybrid[0].bestChunk.highlightedHtml).not.toContain("<mark>");
    expect(embedder.embed).toHaveBeenCalledWith("elastic scaling of containers", "sk-test");
  });

  it("fuses keyword and vector arms into a 'both' match", async () => {
    const embedder = fakeEmbedder({ autoscaler: [1, 0] });

    const hits = await makeService(vectorChunks, embedder).search("autoscaler", {
      apiKey: "sk-test",
    });

    expect(hits[0].page.id).toBe("p1");
    expect(hits[0].matchReason).toBe("both");
    expect(hits[0].scores.keyword).toBeGreaterThan(0);
    expect(hits[0].scores.vector).toBeGreaterThan(0.9);
    expect(hits[0].bestChunk.highlightedHtml).toContain("<mark>autoscaler</mark>");
  });

  it("degrades to keyword-only when chunks have no embeddings", async () => {
    const embedder = fakeEmbedder({ "autoscaler pods": [1, 0] });

    // keywordChunks have no embeddings; the vector arm runs but cosineTopK skips them all.
    const hits = await makeService(keywordChunks, embedder).search("autoscaler pods", {
      apiKey: "sk-test",
    });

    expect(hits[0].matchReason).toBe("keyword");
    expect(hits[0].scores.vector).toBeNull();
    expect(embedder.embed).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm test src/worker/services/RetrievalService.test.ts
```

Expected: FAIL — `RetrievalService` does not accept an embedder arg, produces `score` not `scores`, and never returns `matchReason: "vector" | "both"`.

- [ ] **Step 4: Rewrite RetrievalService**

Replace the entire contents of `src/worker/services/RetrievalService.ts` with:

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

type FusedChunk = {
  chunk: ChunkRecord;
  fused: number;
  keyword: number | null;
  vector: number | null;
  matchReason: PageHit["matchReason"];
  matchedTerms: string[];
};

export class RetrievalService {
  constructor(
    private readonly chunks: ChunkSource = new ChunkRepo(),
    private readonly pages: PageSource = new PageRepo(),
    private readonly embedder: Embedder = new OpenAIProvider(),
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<PageHit[]> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const apiKey = options.apiKey ?? null;
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const allChunks = await this.chunks.allChunks();

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
          // Vector-only hits carry no matched terms → no <mark>; the badge speaks.
          highlightedHtml: highlightTerms(entry.chunk.text, entry.matchedTerms),
        },
        scores: {
          keyword: entry.keyword,
          vector: entry.vector,
          fused: entry.fused,
        },
        matchReason: entry.matchReason,
      });
    }

    return results;
  }
}
```

- [ ] **Step 5: Fix the two downstream `PageHit` fixtures (forced by the type change)**

In `src/worker/index.test.ts`, replace the `searchHit` fixture (lines 41–50) so `score: 1.5` becomes the new `scores` shape:

```ts
const searchHit = {
  page: pendingListItem,
  bestChunk: {
    text: "IndexedDB stores structured data.",
    ordinal: 0,
    highlightedHtml: "IndexedDB stores <mark>structured</mark> data.",
  },
  scores: { keyword: 1.5, vector: null, fused: 1.5 },
  matchReason: "keyword",
} satisfies PageHit;
```

In `src/sidepanel/App.test.tsx`, replace the `hits` fixture (lines 23–34) likewise:

```ts
const hits = [
  {
    page: pages[0],
    bestChunk: {
      text: "The HorizontalPodAutoscaler automatically scales pods.",
      ordinal: 0,
      highlightedHtml: "The HorizontalPodAutoscaler automatically scales <mark>pods</mark>.",
    },
    scores: { keyword: 2.1, vector: null, fused: 2.1 },
    matchReason: "keyword",
  },
] satisfies PageHit[];
```

- [ ] **Step 6: Run the affected suites to verify they pass**

```bash
pnpm test src/worker/services/RetrievalService.test.ts src/worker/index.test.ts src/sidepanel/App.test.tsx
pnpm typecheck
```

Expected: PASS. `SearchResultCard.tsx` and `App.tsx` compile unchanged — neither reads `score` (the card destructures only `page`, `bestChunk`, `matchReason`). The worker handler still calls `search(query, { topK })`; `apiKey` is optional, so it compiles and the existing "runs a keyword search" assertion (`{ topK: undefined }`) still holds.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/worker/services/RetrievalService.ts src/worker/services/RetrievalService.test.ts src/worker/index.test.ts src/sidepanel/App.test.tsx
git commit -m "feat: hybrid keyword+vector retrieval with RRF fusion"
```

---

## Task 2: Wire the API key (and embedder) through the worker

**Files:**

- Modify: `src/worker/index.ts:27-29` (`SearchPort`), `:46` (default deps), `:154-162` (`search.run` handler)
- Test: `src/worker/index.test.ts:125-138`

The vector arm needs the query-time API key. The `search.run` handler fetches it from the store and passes it; with no key, `RetrievalService` skips the vector arm (keyword-only). The default retriever also gets the shared `OpenAIProvider` (created in M5b) as its embedder.

- [ ] **Step 1: Update the failing worker test**

In `src/worker/index.test.ts`, update the search assertion in the "runs a keyword search through RetrievalService" test (around line 135) to expect the API key argument (`makeDeps` returns `apiKey: null` by default):

```ts
    expect(deps.retrievalService.search).toHaveBeenCalledWith("structured data", {
      topK: undefined,
      apiKey: null,
    });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/worker/index.test.ts
```

Expected: FAIL — the handler currently calls `search(query, { topK })` (no `apiKey`), so the assertion does not match.

- [ ] **Step 3: Pass the API key through the handler**

In `src/worker/index.ts`:

(a) Widen the `SearchPort` type (lines ~27–29):

```ts
type SearchPort = {
  search(
    query: string,
    options?: { topK?: number; apiKey?: string | null },
  ): Promise<PageHit[]>;
};
```

(b) Share the embedder with the retriever in `defaultDeps` (the `openai` instance was added in M5b):

```ts
  retrievalService: new RetrievalService(chunkRepo, pageRepo, openai),
```

(c) Replace the `search.run` case (lines ~154–162):

```ts
    case "search.run": {
      const apiKey = await deps.apiKeyStore.getApiKey();

      return {
        type: "search.results",
        payload: {
          hits: await deps.retrievalService.search(request.payload.query, {
            topK: request.payload.topK,
            apiKey,
          }),
        },
      };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test src/worker/index.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts src/worker/index.test.ts
git commit -m "feat: pass API key into hybrid search, share embedder"
```

---

## Task 3: Final M5c verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite, typecheck, lint**

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all PASS.

- [ ] **Step 2: Confirm the hybrid wiring is present**

```bash
rg -n "cosineTopK|reciprocalRankFusion|matchReasonFor" src/worker/services/RetrievalService.ts
```

Expected: matches — the retriever now composes the M5a vector/RRF primitives.

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: succeeds.

- [ ] **Step 4: Manual hybrid sanity (optional, needs a real key)**

Load the unpacked `dist/`, set an OpenAI key, save 2–3 technical pages, then in the side panel run a query whose wording shares **no** literal terms with a saved page's text but matches its meaning (e.g. save a Kubernetes HPA page, search "elastic scaling of containers"). Expect that page to appear with the `vector` badge and no highlight. This is the qualitative check behind parent success criteria #3/#4; the deterministic mechanism is already covered by the unit tests in Task 1. The full "5 hand-built queries hybrid out-ranks keyword-only" bench is part of M5d's manual checklist (it needs real multilingual embeddings).

- [ ] **Step 5: Inspect the diff scope**

```bash
git diff --stat main..HEAD
```

Expected: M5a + M5b files (merged) plus `src/shared/types.ts`, `src/worker/services/RetrievalService*`, `src/worker/index.ts`, `src/worker/index.test.ts`, `src/sidepanel/App.test.tsx`, and the M5 plan files. No `App.tsx`/`SearchResultCard.tsx` code change, no manifest/options change.

---

## Self-Review Notes

- **Spec coverage.** M5c delivers the §6 retrieval pipeline and success criteria #2–#4's mechanism: the keyword arm (§6.1), the vector arm with query embedding + `cosineTopK` skipping un-embedded chunks (§6.2), RRF fusion (§6.3), `matchReason` from arm membership, and §6.5 highlighting (no `<mark>` on vector-only hits). The §4.4 `PageHit.scores`/widened `SearchMatchReason` contract is implemented. CJK keyword search (criterion #4, keyword side) already works via M5a's tokenizer flowing through `bm25Search`; cross-lingual recall (Chinese query → English chunk) rides the vector arm here.
- **Why the in-memory cache is deferred to M5d.** The parent spec (§6, §6.6) describes a preloaded chunk array (+ derived `avgdl`) and an LRU query cache, both "refreshed/invalidated on `page.updated`/`page.removed`." Those broadcasts do not exist until M5d. Adding the cache here would mean a cache with no correct invalidation source — saving a page would not appear in search until the worker restarted, a regression from M4's per-query reads. So M5c keeps M4's per-query `allChunks()` read (correct, green, fast enough at demo scale), and M5d introduces the cache **together with** the broadcasts that invalidate it. `bm25Search` continues to derive `avgdl` from the chunk array it is handed (M4 behavior, parent spec §4.2) — no `corpusStats` table.
- **Breaking change contained in one task.** The `PageHit` reshape ripples to `RetrievalService` (producer), the worker `searchHit` fixture, and the side-panel `hits` fixture. Task 1 changes all of them together so the suite is green at the task boundary. `App.tsx`/`SearchResultCard.tsx` need no edit because they never read `score` — confirmed against the current source.
- **Graceful degradation, two ways.** (1) No API key → vector arm skipped entirely → keyword-only results, no embed call (preserves M4's key-free search; asserted by the "does not call the embedder" test). (2) Key present but chunks predate embeddings (M4 pages) → `cosineTopK` skips them, so they still surface via the keyword arm (asserted by the "degrades to keyword-only when chunks have no embeddings" test). A transient embed error is caught and also degrades to keyword-only rather than failing the whole search.
- **Per-retriever scores are transparency, not the ranking key.** `scores.fused` (RRF) is the sort key and the only score that determines order; `scores.keyword`/`scores.vector` carry the raw BM25/cosine values (or `null` when that arm missed the chunk) for debugging and a possible future UI, per parent spec §4.4. `matchReason` is derived purely from arm membership via `matchReasonFor`, independent of the raw scores.
- **Type consistency.** `SearchOptions.apiKey` is `string | null` to match `ApiKeyStore.getApiKey(): Promise<string | null>`, so the worker passes the store's value straight through. `matchReasonFor` returns `"keyword" | "vector" | "both"`, structurally identical to the widened `SearchMatchReason`. The query vector arrives pre-normalized from the `Embedder` (M5b contract), so `cosineTopK`'s dot-product == cosine assumption holds without re-normalizing here.
