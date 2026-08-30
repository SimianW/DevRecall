# M5 — Embeddings + Hybrid Retrieval — Design

**Date:** 2026-05-31
**Status:** Draft
**Author:** Simian Wang
**Parent spec:** [DevRecall MVP (v1.0)](./2026-05-16-devrecall-mvp-design.md)

---

## 1. Purpose

M4 shipped keyword-only search: word-window chunks scored with BM25-lite,
matched terms highlighted. M5 turns DevRecall into the hybrid retrieval system
the MVP pitch promises — **search by meaning, not by keyword**.

This milestone adds, on top of the M4 foundation:

1. **Token-based chunking** (`js-tiktoken`, replacing word-window chunks).
2. **Embeddings** — one batched OpenAI call per page, vectors stored per chunk.
3. **Vector search** — full-scan cosine over pre-normalized `Float32Array`s.
4. **RRF fusion** — keyword and vector ranks fused with Reciprocal Rank Fusion.
5. **"Matched by meaning" badge** — proves a hit had no literal term overlap.
6. **CJK keyword search** — character-bigram tokenization so Chinese queries
   work in the keyword arm; cross-lingual recall via the multilingual embedding.
7. **Live side-panel refresh** — `page.updated` broadcast updates the affected
   card in place, no full reload.
8. **Side-panel keyboard shortcut** — `chrome.commands`, opens the panel directly.
9. **Single-page delete** — the detail-view "Delete" action, plus a re-index
   path for M4 pages that predate embeddings.

The five hybrid-vs-keyword test queries (success criterion #4 in the parent
spec) pass at the end of M5.

## 2. Scope boundaries

**In scope (M5):** everything in §1.

**Explicitly deferred:**

- Auto-save on allowlist domains → M6.
- Export-all-data, dark-mode pass, README demo GIF → M6.
- RAG-generated answers → v1.1.
- Local/WebGPU embedding models → v1.2+.
- ANN indexes (IVF/HNSW) — only if full-scan is measured slow on real data.
- A real CJK word segmenter (jieba-class) → v1.2+ if bigrams measure insufficient.
- Filter-chip wiring to search results — chips remain decorative until M6 unless
  trivially free; not a success criterion here.

## 3. Success criteria

M5 ships when:

1. Saving a page with a valid API key produces token-based chunks, each with a
   stored 1536-dim embedding, and the page reaches `status: "ready"` only after
   both tags and embeddings are persisted.
2. A query in the side panel returns hybrid results (keyword ∪ vector, RRF-fused)
   in <300ms over a demo-scale corpus, best chunk per page, top-10.
3. At least 5 hand-built queries show hybrid out-ranking keyword-only — including
   one where a vector-only hit carries the "matched by meaning" badge (no literal
   term overlap).
4. A Chinese-language query returns results: keyword arm via CJK bigrams, and/or
   vector arm via the multilingual embedding matching English chunks by meaning.
5. With the side panel open, saving a page shows its card transition
   `pending → ready` live, without a manual reload.
6. The configured keyboard shortcut opens the side panel from any tab.
7. A page can be deleted from the detail view; its row and chunks are removed
   atomically and the side panel reflects the removal live.
8. M4 pages (no embeddings) can be upgraded via an Options "Re-index library"
   action; until then they remain keyword-searchable and degrade gracefully.
9. ≥80% unit coverage on new `lib/` (`vector.ts`, `rrf.ts`, token chunking, CJK
   tokenizer) and `worker/services/` additions.

## 4. Data model changes

### 4.1 `ChunkRecord` — add embedding fields (single table)

```ts
type ChunkRecord = {
  id: string; // ULID
  pageId: string; // FK → PageRecord.id
  ordinal: number; // 0-based position within the page
  text: string; // word-window until processPage re-chunks it to token-based
  embedding?: Float32Array; // 1536 dims, L2-normalized at insert; absent until embedded
  embeddingModel?: string; // e.g. "openai:text-embedding-3-small"; absent until embedded
  tokenCount?: number; // tiktoken count; metadata for detail view / M6 stats; absent on M4 chunks
  schemaVersion: 1;
};
```

**`embedding` is optional, on the same table — not a second table.** Decided in
brainstorming: a chunk and its vector are produced together (in `processPage`),
deleted together, and loaded together (hybrid scoring needs text _and_ vector of
the _same_ chunk in memory at once). Splitting them into two tables would force a
cross-table join on every query and a cross-table transaction on every write,
buying integrity risk for no benefit the M5 architecture can use. A future
multi-model-vector need is handled by a schema migration when it arrives, not
pre-paid now. `Float32Array` survives Dexie/IndexedDB structured clone natively.

The optional fields are absent (not `null`) on chunks written by M4's `save()`
before any `processPage` run. Vector search skips chunks without an `embedding`;
keyword search treats all chunks uniformly. This is the graceful-degradation path
for un-re-indexed M4 pages. `tokenCount` is stored only as metadata (detail view,
M6 storage stats); it is produced for free by token chunking and is **not** used
by retrieval scoring — see §4.2.

### 4.2 BM25 `avgdl` — computed in memory, no `corpusStats` table

The parent spec sketched a persisted `corpusStats` table to feed BM25's average
document length (`avgdl`). M5 does **not** build it. Two reasons:

- **`RetrievalService` already preloads all chunks into an in-memory array** (the
  retrieval design the parent spec mandates). Once the chunks are in memory,
  `avgdl` is a trivial reduction over them — no table, no per-query IndexedDB
  read, no write-time bookkeeping. M4's `bm25Search` already computes `avgdl` from
  the documents it is handed; M5 keeps that.
- **Unit consistency.** BM25's per-document length `|d|` is the count from BM25's
  _own_ `tokenize()`. `avgdl` must be in the same unit. Computing it from the same
  tokenizer over the in-memory chunk texts guarantees this; a persisted
  tiktoken-based token total would be a _different_ unit and would skew scores.

So `avgdl` is derived from the in-memory chunk array (cached alongside it,
recomputed when the array refreshes on `page.updated` / `page.removed`).
`ChunkRecord.tokenCount` is unrelated to BM25 — it is display/stats metadata only.

### 4.3 Dexie schema — no version bump needed

The new `ChunkRecord` fields (`embedding`, `embeddingModel`, `tokenCount`) are
**not indexed** — they are read off the loaded record, never queried by. Dexie
versions track _index_ declarations, not record shape, so adding non-indexed
optional fields requires **no `version()` bump and no migration function**. The
schema stays at v2:

```ts
this.version(2).stores({
  pages: "&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]",
  chunks: "&id, pageId, [pageId+ordinal]",
});
```

Existing M4 `chunks` rows simply read back with the new fields `undefined`. No
table is added, so there is nothing to backfill on upgrade.

### 4.4 Message contract additions

```ts
// DevRecallRequest — add:
| { type: "library.reindex" }            // re-embed all pages missing vectors
| { type: "page.delete"; payload: { id: string } };

// DevRecallResponse — add:
| { type: "library.reindexStarted"; payload: { total: number } }
| { type: "page.deleted"; payload: { id: string } };

// Worker → UI broadcast (chrome.runtime.sendMessage, no awaited response):
| { type: "page.updated"; payload: { page: PageListItem } }
| { type: "page.removed"; payload: { id: string } }
| { type: "library.reindexProgress"; payload: { done: number; total: number } };
```

`SearchMatchReason` widens from `"keyword"` to `"keyword" | "vector" | "both"`.
`PageHit.score` becomes the fused RRF score; per-retriever scores are carried for
debugging/transparency:

```ts
type PageHit = {
  page: PageListItem;
  bestChunk: { text: string; ordinal: number; highlightedHtml: string };
  scores: { keyword: number | null; vector: number | null; fused: number };
  matchReason: "keyword" | "vector" | "both";
};
```

`keyword`/`vector` are `null` when that retriever did not surface the chunk. This
is a breaking change to the M4 `PageHit` shape (`score: number` →
`scores: {...}`); the side panel and its tests update accordingly.

## 5. Capture pipeline (Approach A: embed inside `processPage`)

M4 split capture into two phases: `save()` (no key, writes word chunks → instant
keyword search) and `processPage()` (key, LLM tags → `ready`). M5 folds embedding
into the **existing** `processPage` phase rather than adding a third. All paid
work stays in one key-gated step; the page state machine stays
`pending → ready/failed` with no new status to track.

```
save(tabId):                         // UNCHANGED from M4 — no API key
  extract → upsert(status:pending) → chunkText(word-window) → store chunks
  // page is keyword-searchable immediately

processPage(pageId, apiKey):         // EXTENDED
  ├─ summarizeAndTag(fullText)                    // existing M4 call
  ├─ chunks = chunkTokens(fullText, 500, 50)      // NEW: token-based, js-tiktoken
  ├─ vectors = embedBatch(chunks.map(c => c.text))// NEW: one batched OpenAI call
  │    each vector L2-normalized before storage
  └─ tx('rw', chunks):                            // single atomic transaction
       replace page's chunks with token chunks + vectors + tokenCount
       update page → {…tags, status:'ready'}
  broadcast page.updated { page: toPageListItem(updated) }
```

### Decisions

- **Re-chunk on embed.** `processPage` discards the word-window chunks written by
  `save()` and re-chunks with `js-tiktoken` (accurate OpenAI token counts), then
  embeds. Between `save()` and `processPage`, keyword search runs over the word
  chunks; after, over token chunks. The transition is invisible to the user.
- **One batched embedding call per page** (~5–20 chunks), not per chunk.
- **Normalize at insert time.** Each `Float32Array` is L2-normalized before
  storage so query-time cosine reduces to a dot product. Enforced in the pipeline,
  not left to callers. Query vectors are normalized before search too.
- **One transaction for the upgrade.** Chunk replacement and the page→ready flip
  happen atomically. A half-embedded page never exists. (No corpus-stats table to
  keep in sync — see §4.2.)
- **Failure → `status:'failed'`, `errorReason` set, page kept.** Same as M4 tag
  failures. The page stays keyword-searchable on its word chunks; retry re-runs
  the whole `processPage` (tags + chunks + embeddings — cheap to redo, only the
  API calls cost money). Embedding-specific errors reuse the M4 code set
  (`auth | rate_limited | network | parse | unknown`).

## 6. Retrieval pipeline

```
RetrievalService.search(query, topK=10):
  ├─ normalize(query)            lowercase, collapse whitespace
  ├─ allChunks = preloaded in-memory array (refreshed on page.updated/removed)
  ├─ parallel:
  │    ├─ keywordSearch(query, allChunks)        → ScoredChunk[]  (BM25-lite, all chunks)
  │    └─ vectorSearch(query, allChunks, apiKey) → ScoredChunk[]  (cosine, embedded chunks only)
  ├─ fuse with RRF(k=60) over the two ranked lists
  ├─ group by pageId, keep best (highest fused) chunk per page
  ├─ join PageRecord metadata (toPageListItem)
  └─ return PageHit[] (top-10), each with scores + matchReason + highlightedHtml
```

### 6.1 Keyword arm (extends M4 `bm25.ts`)

Unchanged BM25-lite math (`k1=1.5, b=0.75`), with one M5 change: the tokenizer
gains CJK support (§6.4). Query and chunk text tokenize identically, as before.
`avgdl` and per-document length both come from that same tokenizer over the
in-memory chunk array (§4.2) — M4's behavior, unchanged.

Runs over **all** chunks (embedded or not), so un-re-indexed M4 pages still
participate in keyword results.

### 6.2 Vector arm (new `lib/vector.ts` + retriever)

- Embed the query via `LLMProvider.embed(query, apiKey)` → `Float32Array(1536)`,
  L2-normalized.
- Full-scan every chunk **that has an `embedding`**; cosine = dot product because
  both sides are pre-normalized. Chunks without a vector (M4 pages) are skipped
  here but remain in the keyword arm.
- Keep top-K (default 50).
- `lib/vector.ts` is pure: `normalize(v)`, `dot(a, b)`, `cosineTopK(query, chunks, k)`.
  No `chrome.*`, trivially unit-testable.

**No API key →** the vector arm is skipped entirely; search degrades to
keyword-only (and the UI shows no "matched by meaning" badges). This preserves
M4's "search works without a key" property.

### 6.3 Fusion: Reciprocal Rank Fusion (new `lib/rrf.ts`)

```
fused(c) = Σ_{i ∈ {keyword, vector}}  1 / (k + rank_i(c)),   k = 60
```

- Rank-based, so it ignores that BM25 scores live in `[0, ~10]` and cosine in
  `[-1, 1]` — no score normalization needed. ~5 lines.
- A chunk present in only one list still scores (just one term). A chunk in both
  scores higher → `matchReason: "both"`.
- `matchReason` derives from which lists contained the winning chunk:
  - in keyword list only → `"keyword"`
  - in vector list only → `"vector"` ← the "matched by meaning" case
  - in both → `"both"`
- `lib/rrf.ts` is pure: takes two ranked `string[]` (or `{id}` lists) and returns
  `Map<id, {fused, inKeyword, inVector}>`. Unit-testable in isolation.

### 6.4 CJK tokenization (extends `bm25.ts` `tokenize`)

The M4 tokenizer (`split(/[^a-z0-9]+/)`) drops CJK text entirely. M5 makes
`tokenize` script-aware:

- Walk the lowercased string. **Latin/digit runs** tokenize as before (split on
  non-alphanumeric, drop stopwords).
- **CJK runs** (Unicode ranges for Han, Hiragana, Katakana, Hangul) emit
  **character bigrams**: `自动扩缩` → `自动`, `动扩`, `扩缩`. A single CJK
  character emits itself as a unigram.
- The two token streams concatenate, so mixed text tokenizes correctly:
  `"React 服务端渲染"` → `["react", "服务", "务端", "端渲", "渲染"]`.
- Same tokenizer for query and chunk text, so bigram-vs-bigram matching is
  symmetric. No dictionary, no WASM segmenter.

Cross-lingual recall (Chinese query → English chunk) is carried by the **vector
arm**, not the keyword arm — the embedding model is multilingual. CJK bigrams
make the keyword arm useful for Chinese rather than dead weight; they are not the
cross-lingual mechanism.

### 6.5 Highlighting (extends M4 `highlight.ts`)

- Keyword/both hits: wrap matched terms in `<mark>` (M4 behavior; CJK matched
  terms are bigrams, so a Chinese match highlights the matched 2-char spans).
- Vector-only hits (no literal term overlap): no `<mark>`; the card shows a
  **"matched by meaning"** badge instead. This is the demo moneyshot.

### 6.6 Caching

`RetrievalService` keeps an LRU(20) `query → PageHit[]` cache in worker memory,
invalidated on any `page.updated` / `page.removed` broadcast. Makes
type-as-you-search feel instant. The preloaded `allChunks` array is also
refreshed on those broadcasts so search never reads stale chunks.

## 7. New surfaces and flows

### 7.1 Live side-panel refresh

The parent spec always _designed_ for a `page.updated` broadcast; M4 never wired
the listening side. M5 does:

- Worker broadcasts `page.updated { page: PageListItem }` after `processPage`
  completes (and after `save()` inserts the pending row), and
  `page.removed { id }` after a delete.
- Side panel registers `chrome.runtime.onMessage`. On `page.updated`: find the
  card by `page.id` in local state — replace if present, insert at top if new.
  On `page.removed`: drop it. **No full `page.list` reload.**
- The listener reconciles the **library list** state. If a search is active
  (`submittedQuery` non-empty), the broadcast updates the underlying library
  state but does not disturb the visible result list until the next query — search
  results are a query snapshot, not a live view.
- Broadcasts are fire-and-forget (`chrome.runtime.sendMessage` with no awaited
  response). If no side panel is open, the message has no receiver and the worker
  ignores the resulting "no receiving end" error.

### 7.2 Keyboard shortcut

- `manifest.config.ts` gains a `commands` entry:
  ```ts
  commands: {
    "open-side-panel": {
      suggested_key: { default: "Ctrl+Shift+K", mac: "Command+Shift+K" },
      description: "Open the DevRecall side panel",
    },
  }
  ```
- Worker listens `chrome.commands.onCommand`; on `"open-side-panel"` it calls
  `chrome.sidePanel.open({ windowId })` **synchronously** within the command event
  (same user-gesture rule as the popup button — no `await` before the call).
- User-rebindable at `chrome://extensions/shortcuts`. If Chrome reports the
  default combo as already taken, the command simply stays unbound until the user
  assigns one — no error surfaced.

### 7.3 Re-index library (M4-page upgrade)

M4 pages have word chunks and no vectors. The Options page gains a **"Re-index
library"** action:

- Options sends `library.reindex`. Worker scans for pages whose chunks lack
  embeddings (`status: "ready"` pages with no embedded chunks), responds
  `library.reindexStarted { total }`, then processes them **sequentially** (one
  page at a time — MV3 workers are memory-constrained and OpenAI rate-limits;
  sequential keeps it predictable and resumable).
- For each page it runs the same embed path as `processPage` (re-chunk with
  tiktoken + embed + atomic chunk write), then broadcasts
  `library.reindexProgress { done, total }`.
- Options shows `"Re-indexing 2 / 7…"`; the button is disabled with a count of
  pages missing embeddings when idle (`"3 pages missing embeddings"`).
- Requires an API key (it costs money). Button disabled with the standard "Set
  API key" hint when no key is configured.
- Interruptible by worker death: since each page is its own atomic transaction,
  a killed worker leaves already-done pages embedded and the rest still
  keyword-only. Re-clicking resumes from what's left.

### 7.4 Single-page delete

The detail-view "Delete" action (designed in parent spec §8, unimplemented until
now):

- Side panel sends `page.delete { id }`. Worker deletes the page row and its
  chunks in one `rw` transaction. Responds `page.deleted { id }` and broadcasts
  `page.removed { id }`.
- `RetrievalService` drops the page's chunks from its in-memory array and
  invalidates the query cache on the `page.removed` broadcast.
- This is the only delete path in M5. "Delete all data" stays in M6.

## 8. Components and files

### New files

- `src/lib/vector.ts` — pure: `normalize`, `dot`, `cosineTopK`.
- `src/lib/rrf.ts` — pure: reciprocal rank fusion over two ranked lists.
- `src/lib/tokenChunking.ts` — `chunkTokens(text, maxTokens=500, overlap=50)`
  using `js-tiktoken`. Separate from M4's word-window `chunking.ts`, which stays
  for the pre-embedding `save()` path.
- `src/worker/llm/MockLLMProvider.ts` — deterministic hash-based
  `Float32Array(1536)` embeddings + canned tags, for integration tests.

### Extended files

- `src/shared/types.ts` — `ChunkRecord` embedding fields, `PageHit.scores`,
  widened `SearchMatchReason`.
- `src/shared/messages.ts` — the §4.4 request/response/broadcast additions.
- `src/worker/repository/ChunkRepo.ts` — write embeddings on replace; expose the
  full chunk set (with vectors) for the retrieval array.
- `src/worker/llm/OpenAIProvider.ts` — add
  `embedBatch(texts: string[], apiKey): Promise<Float32Array[]>` and
  `embed(text, apiKey): Promise<Float32Array>` (POST `/v1/embeddings`,
  `text-embedding-3-small`). Add an `Embedder` port alongside the existing
  `PageTagger` port.
- `src/lib/bm25.ts` — CJK-aware `tokenize` (avgdl/`|d|` already self-computed
  from the documents passed in; unchanged).
- `src/worker/services/CaptureService.ts` — `processPage` embeds (Approach A);
  add an `Embedder` port. Add a `reindexLibrary` path (reuses the embed step).
- `src/worker/services/RetrievalService.ts` — hybrid: keyword ∪ vector arms, RRF,
  in-memory chunk array (+ derived avgdl) + LRU query cache, broadcast-driven
  invalidation.
- `src/worker/index.ts` — dispatch `library.reindex`, `page.delete`; emit
  `page.updated` / `page.removed` / `library.reindexProgress` broadcasts;
  `chrome.commands.onCommand`.
- `src/sidepanel/App.tsx` — `onMessage` listener for live refresh; detail-view
  delete; `scores`/`matchReason` rendering.
- `src/options/Options.tsx` — "Re-index library" control with progress.
- `manifest.config.ts` — `commands` entry.

## 9. Testing strategy

Follows the parent spec's three layers; ≥80% on new `lib/` and
`worker/services/`.

### Unit (Vitest, pure)

- `vector.ts` — `normalize` produces unit vectors; `dot` of normalized vectors
  equals cosine; `cosineTopK` ranks a hand-built fixture correctly; skips chunks
  without embeddings.
- `rrf.ts` — fuses two ranked lists; a both-lists item out-ranks single-list
  items; `inKeyword`/`inVector` flags drive `matchReason`; `k=60` default.
- `tokenChunking.ts` — token counts via tiktoken; overlap honored; blank input.
- `bm25.ts` CJK — `tokenize("自动扩缩")` → `["自动","动扩","扩缩"]`;
  mixed `"React 服务端渲染"` → Latin + bigrams; single CJK char → unigram;
  existing Latin/stopword behavior unchanged.

### Integration (Vitest, `fake-indexeddb` + `MockLLMProvider`)

- `CaptureService.processPage` end-to-end with the mock embedder: page reaches
  `ready`, chunks carry deterministic vectors + `tokenCount`, `page.updated`
  broadcast emitted.
- `RetrievalService.search`: 20-page fixture, asserts top-K for the **5 hybrid
  queries** (parent success criterion #4), including one vector-only hit with
  `matchReason: "vector"`. Asserts keyword-only fallback when chunks lack vectors
  or no API key is set.
- Re-index flow: M4-style pages (word chunks, no vectors) → `library.reindex` →
  all chunks embedded, progress broadcasts emitted, resumable after simulated
  interruption.
- `page.delete`: page + chunks gone, `page.removed` broadcast emitted, in a single
  transaction.

### Manual / E2E

- Manual Chrome checklist (provided to the user) covers: live `pending → ready`
  with panel open, keyboard shortcut opens panel, Chinese query returns results,
  "matched by meaning" badge on a vector-only hit, delete from detail view,
  re-index of a pre-M5 page.
- The parent spec's single Playwright happy-path is extended to type a query and
  assert a hybrid result; OpenAI calls mocked via Playwright `route`.

## 10. Open questions / risks

- **tiktoken bundle size in MV3.** `js-tiktoken` ships the encoder rank data;
  confirm the built worker stays within reasonable size. If problematic, lazy-load
  the encoder only inside `processPage` (the embed path), keeping it out of the
  search path. Flag during implementation if the bundle grows materially.
- **Embedding dim assumption.** 1536 is hard-coded for `text-embedding-3-small`.
  A model change is a re-index migration (v1.2+), not an M5 concern.
- **Full-scan latency.** Benchmark target <50ms for cosine over demo-scale
  corpora; revisit ANN only if measured slow on real data (parent spec §7).
