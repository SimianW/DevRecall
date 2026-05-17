# DevRecall MVP (v1.0) — Design

**Date:** 2026-05-16
**Status:** Approved (pending user spec review)
**Author:** Simian Wang

---

## 1. Purpose

DevRecall is a local-first Chrome extension that captures technical browsing sessions, summarizes and tags saved pages, and lets developers retrieve past documentation, GitHub issues, Stack Overflow answers, and debugging notes through natural-language search.

This document specifies the v1.0 ("MVP") milestone: **capture + hybrid (keyword + vector) retrieval**, with no LLM-generated answers. RAG answer generation is designed-for and lives in v1.1.

## 2. Goals & non-goals

### Primary goals

- Ship a portfolio-grade Chrome extension demonstrating modern MV3 internals, React+Vite+TypeScript fluency, and a real retrieval system.
- Make the "search by meaning, not by keyword" pitch demonstrable in a 60-second video.

### Non-goals (v1.0)

- Chrome Web Store launch.
- RAG-generated answers (designed-for; deferred to v1.1).
- Local embedding models (deferred to v1.5+).
- Cross-device sync, encryption, screenshots, knowledge graphs.

## 3. Success criteria

v1.0 ships when:

1. User clicks "Save" in the popup on any page → page appears in the side panel library within 5 seconds with summary + tags.
2. Allowlist domains (GitHub, Stack Overflow, MDN, kubernetes.io, etc.) auto-save after 30s of dwell time.
3. User opens side panel, types a natural-language query → top-10 results return in <300ms with the matching chunk highlighted.
4. Hybrid search visibly outperforms keyword-only on at least 5 hand-built test queries (e.g., "auto scale pods" matches HPA docs that don't contain "auto scale").
5. Settings page accepts an OpenAI API key, stored in `chrome.storage.local`.
6. README has install instructions + a 60-second demo GIF.
7. ≥80% unit test coverage on `lib/` and `worker/services/`.

## 4. High-level architecture

Five components, talking via well-defined boundaries:

```
┌──────────────────────┐         ┌──────────────────────┐
│  Content Script      │         │  Popup (toolbar)     │
│  - extract main text │         │  - "Save this page"  │
│  - dwell-time timer  │         │  - status footer     │
│  - on demand only    │         │  - open side panel   │
└──────────┬───────────┘         └──────────┬───────────┘
           │  chrome.runtime.sendMessage    │
           │       (typed RPC)              │
           ▼                                ▼
        ┌──────────────────────────────────────────────┐
        │  Service Worker (background)                 │
        │  ┌────────────────┐  ┌────────────────────┐  │
        │  │ CaptureService │  │ RetrievalService   │  │
        │  └───────┬────────┘  └─────────┬──────────┘  │
        │          ▼                     ▼             │
        │  ┌──────────────┐    ┌────────────────────┐  │
        │  │ LLMProvider  │    │ Repository (Dexie) │  │
        │  │ (interface)  │    └─────────┬──────────┘  │
        │  └──────┬───────┘              │             │
        └─────────┼──────────────────────┼─────────────┘
                  │                      │
                  ▼                      ▼
            ┌──────────┐         ┌──────────────┐
            │ OpenAI   │         │  IndexedDB   │
            │ API      │         │              │
            └──────────┘         └──────────────┘
                                        ▲
                                        │
                                ┌───────┴──────────┐
                                │  Side Panel      │
                                │  - search        │
                                │  - library list  │
                                │  - result detail │
                                └──────────────────┘
```

### Component responsibilities

1. **Content Script** — extracts main page text via `@mozilla/readability`. Stateless: injected on-demand via `chrome.scripting.executeScript`, runs `extract()`, returns the result, and is torn down. Dwell time for manual saves is computed from `performance.now()` at injection time (approximate page-open duration). For auto-save, the dwell timer lives in the worker's `CaptureService` (§6).
2. **Popup** — toolbar entry point. Save action only. Sends messages, never reads IndexedDB.
3. **Side Panel** — main UI. Three views: search, library, page detail. Sends queries to the worker, renders ranked results.
4. **Service Worker** — the brain. Hosts `CaptureService`, `RetrievalService`, the `LLMProvider` interface (with `OpenAIProvider`), and the Dexie repository layer.
5. **IndexedDB (via Dexie)** — single persistence boundary.

### Architectural decisions

- **All UI talks through the worker.** Single place to change schema, single place to hold the API key, makes RAG drop-in for v1.1. Worker is the only DB writer → no write/write races.
- **Retrieval lives inside the service worker** (not the side panel). The MV3 service-worker lifecycle is intentional surface area to learn and to display on a resume. Worker may be killed mid-search → mitigated by keeping retrieval state rebuildable from IndexedDB and using a 3s retry on the side-panel side.
- **Typed RPC contract.** All `chrome.runtime` messages go through a single typed dispatcher with a `Request → Response` discriminated union. No string-typed event soup:

```ts
type DevRecallRequest =
  | { type: "page.save"; payload: { tabId: number } }
  | { type: "page.list"; payload: { limit: number; cursor?: string } }
  | { type: "page.get"; payload: { id: string } }
  | { type: "page.delete"; payload: { id: string } }
  | { type: "search.run"; payload: { query: string; topK: number } }
  | { type: "settings.setApiKey"; payload: { key: string } }
  | { type: "settings.getStatus" };
```

## 5. Data model

Three tables in IndexedDB via Dexie.

```ts
interface PageRecord {
  id: string; // ULID — sortable, URL-safe
  url: string; // normalized canonical URL
  urlHash: string; // sha256(url) — index for dedupe lookup
  title: string;
  domain: string;
  sourceType: SourceType; // 'official_docs' | 'github_issue' | 'stackoverflow'
  //   | 'blog' | 'paper' | 'course_material' | 'unknown'
  // 'unknown' is the default before LLM tagging completes
  summary: string; // 1–3 sentences, LLM-generated. Empty string while status='pending'.
  topics: string[]; // empty array until LLM tagging completes
  technologies: string[]; // empty array until LLM tagging completes
  intent: Intent; // 'learning' | 'debugging' | 'reference' | 'implementation' | 'comparison'
  // 'reference' is the default before LLM tagging completes
  fullText: string; // raw extracted text — kept for keyword search & re-chunking
  savedAt: number;
  visitedAt: number; // most recent visit; auto-save updates this
  readingTimeMs: number;
  saveMode: "manual" | "auto";
  status: "pending" | "ready" | "failed";
  errorReason?: string;
  schemaVersion: 1;
}

interface ChunkRecord {
  id: string; // ULID
  pageId: string; // FK → PageRecord.id
  ordinal: number; // 0-based position in page
  text: string; // ~500 tokens, ~50-token overlap with neighbors
  embedding: Float32Array; // 1536 dims; pre-normalized at insert time
  embeddingModel: string; // 'openai:text-embedding-3-small'
  tokenCount: number;
}

interface SettingsRecord {
  id: "singleton";
  // API key is NOT stored here — see § 5 "Non-obvious decisions". This field is
  // reserved for a future encrypted-key feature flag and is unused in v1.0.
  apiKeyEncryptedRef?: string;
  llmProvider: "openai";
  llmModel: "gpt-4o-mini";
  embeddingModel: "text-embedding-3-small";
  autoSaveEnabled: boolean;
  autoSaveDwellMs: number; // default 30_000
  schemaVersion: 1;
}

interface CorpusStatsRecord {
  id: "singleton";
  docCount: number; // total number of ChunkRecords
  totalTokens: number; // sum of ChunkRecord.tokenCount across all chunks
  // avgdl = totalTokens / docCount — recomputed in BM25 at query time, never stored
  schemaVersion: 1;
}
```

### Dexie indexes

- `pages: '&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]'`
- `chunks: '&id, pageId, [pageId+ordinal]'`
- `settings: '&id'`
- `corpusStats: '&id'`

### Non-obvious decisions

- **`urlHash` for dedupe.** Re-saving the same URL updates in place. O(1) lookup. `url` is not separately indexed — `urlHash` is the canonical dedupe key.
- **`[sourceType+savedAt]` compound index.** Library view filters by `sourceType` and sorts by `savedAt` descending. Without this compound index, filtered library views require a full O(n) scan over `pages`.
- **`fullText` is stored.** Primarily for re-chunking if the chunking strategy changes in a future version. BM25 search runs over `ChunkRecord.text`, not `fullText`. Acknowledged cost: ~2× storage per page (~50KB fullText + chunk overlaps). ~50KB/page → 20k pages = ~1GB, within IndexedDB quota.
- **`embedding: Float32Array`** (not `number[]`). 4× smaller storage, 4× faster cosine similarity. Dexie/IndexedDB preserves typed arrays natively via structured clone.
- **`embeddingModel` per chunk.** Enables future migrations to know which chunks are stale.
- **`status` field.** Save is async; UI shows pending/failed states. Without it the library would lie during slow saves.
- **`schemaVersion: 1`** on records that may evolve. Dexie migrations key off this.
- **No separate `tags` table.** Arrays on `PageRecord` are sufficient for v1.0.
- **API key in `chrome.storage.local`, not IndexedDB.** `chrome.storage.local` is partitioned per extension and unreachable from content scripts. Defense in depth.
- **`navigator.storage.persist()` at install time.** IndexedDB is best-effort storage by default — Chrome can silently evict it under disk pressure. Called from the popup on first open (the only guaranteed window context early in the extension lifecycle; `chrome.runtime.onInstalled` runs in the service worker where `persist()` is unavailable). Options page shows whether persistent storage was granted. Without this, large stores can be cleared without warning.

## 6. Capture pipeline

```
[Popup] click "Save"
   │  chrome.runtime.sendMessage({type:'page.save', tabId})
   ▼
[Worker · CaptureService.save(tabId)]
   │
   ├─1. chrome.scripting.executeScript({tabId, func:extract})
   │      → returns { url, title, html, dwellMs }
   │
   ├─2. Readability.parse(html) → mainText  (runs in content script)
   │
   ├─3. normalizeUrl(url) → canonical url + urlHash
   │      strip #fragments, utm_*, gclid, fbclid
   │
   ├─4. repo.upsertPage({status:'pending', ...basics})
   │      ─── popup closes; side panel shows pending row ───
   │
   ├─5. Promise.all([
   │      llm.summarizeAndTag(mainText)  →  {summary, sourceType, topics,
   │                                         technologies, intent}
   │      chunk(mainText, 500, 50)       →  ChunkInput[]  (pure function)
   │    ])
   │
   ├─6. llm.embedBatch(chunks.map(c=>c.text))  →  Float32Array[]
   │      (one batched API call, not N)
   │      → normalize each vector: v = v / ||v||₂
   │        (required so cosine similarity reduces to dot product at query time)
   │
   ├─7. repo.tx('rw', pages, chunks, () => {
   │       update page → status:'ready' + summary/tags
   │       insert all chunks atomically
   │    })
   │
   └─8. broadcast 'page.updated' → side panel refreshes
```

### Decisions

- **Two-phase write (steps 4 + 7).** Page row inserted as `pending` immediately for instant UI feedback. Step 7 is one transaction so a half-saved page never exists.
- **Readability runs in the content script.** Service workers have no DOM. The content script returns already-extracted plain text up to the worker via `chrome.scripting.executeScript`'s return value — no separate message round-trip.
- **Chunking is a pure function.** `chunk(text, size=500, overlap=50)` using `js-tiktoken` for accurate counts against the OpenAI tokenizer. Lives in `lib/chunking.ts`. Trivially testable.
- **Embeddings batched.** One API call per page (~5–20 chunks), not per-chunk. Latency + cost win.
- **Vectors normalized at insert time.** Each `Float32Array` is L2-normalized before storage so cosine similarity at query time reduces to a dot product. This is enforced in step 6 of the capture pipeline (not left to callers). Query vectors are also normalized before search.
- **Errors are typed and persisted.** If steps 5/6 fail: `status:'failed'`, `errorReason` set, page stays in DB. UI offers retry.
- **Idempotency.** Re-saving overwrites. Cheap because main text is already extracted; only LLM calls cost money.
- **No concurrency cap.** Save calls run in parallel; OpenAI SDK rate-limits internally.

### Auto-save (built in milestone M6)

- Listens to `chrome.tabs.onUpdated` for `status:'complete'`.
- If `domain ∈ allowlist`, start a 30s dwell timer keyed on `tabId`.
- Also listens to `chrome.tabs.onActivated` — cancels any running dwell timer when the user switches away from a tab, since the page is no longer being viewed.
- If still on the page after 30s and tab still active → `CaptureService.save(tabId, {mode:'auto'})`.
- Allowlist hard-coded in v1.0: `['github.com', 'stackoverflow.com', 'developer.mozilla.org', 'kubernetes.io', 'docs.python.org', 'react.dev', 'nodejs.org', 'typescriptlang.org']`. User-editable in v1.1.

### Delete flow

- Triggered from side panel detail view or "Delete all data" on options page.
- Single-page delete: `repo.tx('rw', pages, chunks, corpusStats, () => { delete page; delete its chunks; subtract chunk count + tokens from corpusStats })`. One transaction — either all gone or all kept.
- "Delete all": `repo.tx('rw', pages, chunks, corpusStats, () => { clear all three tables; reset corpusStats to zero })`.
- After either delete: broadcast `page.updated` → side panel refreshes, `RetrievalService` invalidates caches and reloads chunk array.

## 7. Retrieval pipeline

```
[Side Panel] user types "auto scale pods"
   │  chrome.runtime.sendMessage({type:'search.run', query, topK:10})
   ▼
[Worker · RetrievalService.search(query)]
   │
   ├─1. normalize(query) → "auto scale pods"
   │     lowercase, strip punctuation, collapse whitespace
   │
   ├─2. parallel fan-out:
   │     ├─ keywordSearch(query)   → ScoredChunk[] (BM25-lite)
   │     └─ vectorSearch(query)    → ScoredChunk[] (cosine top-K)
   │
   ├─3. fuse with Reciprocal Rank Fusion (RRF, k=60)
   │     score(c) = Σ  1/(k + rank_i(c))
   │            i ∈ {keyword, vector}
   │
   ├─4. group chunks by pageId, keep best chunk per page
   │
   ├─5. join PageRecord metadata
   │
   └─6. return PageHit[]  (top-10)
```

### Retrievers

**Keyword — BM25-lite, ~80 lines.**

- Tokenize query and chunk text identically (lowercase, split on `\W+`, drop stopwords).
- For each unique query term, walk all chunks (full scan for v1.0).
- Score: `Σ_terms IDF(t) · (tf · (k1+1)) / (tf + k1·(1 - b + b·|d|/avgdl))`, `k1=1.5, b=0.75`.
- `avgdl = corpusStats.totalTokens / corpusStats.docCount` — loaded from the `corpusStats` table at query time. Updated atomically inside the step-7 capture transaction on every page upsert and delete so scores don't drift as the corpus grows.
- Keep top-K (default 50).
- Sufficient for 10k–20k chunks: each chunk is ~8KB (2KB text + 6KB Float32Array embedding), so a full scan loads ~80–160MB into worker memory. `RetrievalService` preloads all chunks at worker startup into an in-memory array (refreshed on `page.updated` broadcast) to avoid per-query IndexedDB deserialization. Memory budget is acceptable for a portfolio/demo workload; inverted index deferred to when measured slow on real data.

**Vector — cosine over Float32Array, ~30 lines.**

- Embed query via `LLMProvider.embed(query)` → `Float32Array(1536)`.
- Full scan all chunks; cosine reduces to a dot product because vectors are pre-normalized at insert time.
- Keep top-K (default 50).
- Benchmark target: full scan over 10k×1536-dim vectors should complete in <50ms in a service worker (naïve JS dot product over pre-normalized Float32Arrays). ANN structures (IVF/HNSW) only if measured above that threshold.

### Fusion: Reciprocal Rank Fusion

Rank-based, so it doesn't care that BM25 scores live in [0, ~10] and cosine in [-1, 1]. No score normalization needed. ~5 lines of code. Used by Elastic and Vespa in production.

### Highlighting

- Keyword-matched chunk: wrap query terms in `<mark>`.
- Vector-matched chunk (no literal term overlap): "matched by meaning" badge instead. This is the moneyshot of the demo — visibly proves the system isn't doing keyword search.

### Caching

- `RetrievalService` keeps an LRU(20) `query → result` cache in worker memory.
- Invalidated on any `page.updated` broadcast.
- Makes type-as-you-search feel instant.

### Result shape

```ts
PageHit = {
  page: { id, url, title, domain, summary, topics, technologies, savedAt },
  bestChunk: { text, ordinal, highlightedHtml },
  scores: { keyword, vector, fused },
  matchReason: "keyword" | "vector" | "both",
};
```

## 8. UI

Two surfaces only.

### Popup (~320×220, opens from toolbar icon)

```
┌──────────────────────────────────┐
│  DevRecall                       │
├──────────────────────────────────┤
│  📄 Horizontal Pod Autoscaling   │
│     kubernetes.io                │
│                                  │
│  [  Save this page          ]   │
│                                  │
│  Last saved: HPA — 2m ago        │
│  [ Open library ↗ ]              │
└──────────────────────────────────┘
```

- Save button states: idle → "Saving…" → "Saved ✓" (1.5s) → idle. On error: "Failed — open settings?"
- If no API key: button disabled with inline "Set API key in settings."
- "Open library ↗" calls `chrome.sidePanel.open()` **synchronously in the click handler** — no `await` before this call. Chrome requires `sidePanel.open()` to execute within the original user gesture; any async work (e.g., checking API key status) must happen after the call, not before.

### Side Panel (resizable, default 400px, persistent across tabs)

```
┌────────────────────────────────────┐
│ DevRecall                       ⚙  │
├────────────────────────────────────┤
│ [ search…                       ] │  ← always-visible, debounced 200ms
│                                    │
│ [ All ] [ Docs ] [ SO ] [ GH ]    │  ← sourceType filter chips
├────────────────────────────────────┤
│  ◐ matched by meaning              │
│  Horizontal Pod Autoscaling        │
│  kubernetes.io · 3 days ago        │
│  "The HorizontalPodAutoscaler      │
│   automatically updates a workload │
│   resource…"                       │
│  #Kubernetes  #Autoscaling         │
│  ──────────────────────────────    │
│  ⌕ keyword + meaning               │
│  React hydration mismatch in SSR   │
│  github.com · 1 week ago           │
│  …                                 │
└────────────────────────────────────┘
```

- Empty query → library view (saved pages newest-first, infinite scroll).
- Filter chips toggle `sourceType`. Multi-select.
- Click result body → opens URL in new tab; click "···" → delete, copy URL, view detail.
- Pending saves render at the top with a spinner.

### Page detail view (in-side-panel, slide-over)

- Full summary, all chips, save/visit timestamps, dwell time.
- "Original page chunks" expandable — shows all chunks with their ordinals. Useful for debugging retrieval; reads as transparent on a portfolio piece.
- "Open original" + "Delete" actions.

### Options page (full tab)

- API key input (password field, show/hide toggle, "test connection" button that sends `POST /v1/embeddings` with a one-token input). This exercises the exact API path the extension uses and fails fast if the key lacks embedding permissions — unlike `GET /v1/models` which succeeds for any valid key regardless of scope. Cost is negligible (~0.00002¢ per test) since a single token is embedded. A "Testing…" loading state prevents double-clicks.
- Auto-save toggle + dwell threshold slider.
- Storage usage: "X pages, Y chunks, Z MB."
- "Export all data" (JSON download).
- "Delete all data" with confirmation.

### Design system

- Tailwind, system font stack, no custom design system.
- `prefers-color-scheme` dark mode via Tailwind.
- One reusable `<PageCard>` component used in side-panel results and library view.

## 9. Error handling

### Failure modes

| Failure                                         | Where caught                      | User sees                                                                                                                                                                                                                          | Persisted?        |
| ----------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| No API key set                                  | Worker pre-check before LLM calls | Save button disabled; side panel banner "Set API key →"                                                                                                                                                                            | n/a               |
| Invalid API key (401)                           | `OpenAIProvider`                  | Toast "API key rejected. Check settings." + row `failed`, `errorReason: 'auth'`                                                                                                                                                    | yes (retry)       |
| Rate limit (429)                                | `OpenAIProvider`                  | Auto-retry with exponential backoff (3 attempts: 1s/2s/4s). On final failure: `errorReason: 'rate_limited'`                                                                                                                        | yes               |
| Network down                                    | `OpenAIProvider`                  | Same as rate limit but `errorReason: 'network'`                                                                                                                                                                                    | yes               |
| Readability returns nothing                     | `CaptureService` step 2           | Toast "Couldn't read page content" — no row created                                                                                                                                                                                | no                |
| Page is `chrome://`, `file://`, PDF, etc.       | `CaptureService` step 1           | Save button disabled with tooltip "DevRecall can't save this page type"                                                                                                                                                            | no                |
| LLM returns malformed tag JSON                  | `OpenAIProvider`                  | One retry with stricter prompt; on second failure save with `topics:[], technologies:[]` and log warning                                                                                                                           | yes (best-effort) |
| IndexedDB quota exceeded                        | `Repository`                      | Side panel banner "Storage full. Delete pages or export." + block new saves                                                                                                                                                        | n/a               |
| Worker killed mid-save (after step 4, before 7) | Recovery on next boot             | On worker init, scan `status:'pending' AND savedAt < now-5min`. If chunks exist for the page → status was written in step 7, mark `ready`. If no chunks exist → step 7 never ran, mark `failed` with `errorReason: 'interrupted'`. | yes               |

### Patterns

- **Single error type.** All worker-side errors throw `DevRecallError` with `code: 'auth' | 'rate_limited' | 'network' | 'extract' | 'storage' | 'parse' | 'interrupted' | 'unknown'`. UI maps codes → strings in one place.
- **Errors don't lose work.** If we have the extracted text, we save the row in `failed` state and offer retry.
- **Toasts for transient errors; banners for persistent ones.**
- **No silent failures.** Every catch either updates a record's status field or surfaces to the UI.

### Observability (dev-only, no Sentry)

- All worker logs go through a single `log(level, event, data)` sink → `console` + in-memory ring buffer (last 200 entries, plain JS array in worker scope).
- The ring buffer is **not** written to `chrome.storage.session` on every call — that would add an async IPC round-trip per log statement. Instead, it is flushed to `chrome.storage.session` only when "Copy logs" is clicked (or on demand).
- Options page has "View recent activity" + "Copy logs" button.

### Telemetry

None. The README states this explicitly.

## 10. Testing strategy

### Three layers

1. **Unit (Vitest)** — pure functions.
   - `chunking.ts`, `bm25.ts`, `vector.ts`, `rrf.ts`, `urlNormalize.ts`.
   - `OpenAIProvider` with mocked HTTP — verifies request shape, JSON parsing, retry/backoff.
   - `Repository` against `fake-indexeddb` — upsert dedupe, transactional chunk insert, status transitions.

2. **Integration (Vitest)** — worker services wired together with `fake-indexeddb` + `MockLLMProvider` returning deterministic embeddings (hash-based `Float32Array(1536)`).
   - `CaptureService.save` end-to-end: input HTML → expected page row + chunks.
   - `RetrievalService.search`: 20-page fixture corpus, asserts top-K for ~10 hand-picked queries. **This is the success-criteria #4 test.**
   - Pipeline failure paths: provider throws → row marked `failed`; retry succeeds.

3. **E2E (Playwright)** — one happy-path script.
   - Loads the unpacked extension, opens a fixture HTML page served locally, clicks Save, opens the side panel, types a query, asserts a result appears.
   - Mocks OpenAI calls via Playwright `route` API.
   - One test, not a suite. Value is "manifest + messaging works on a real Chromium," not coverage.

### Fixtures

- Three real-world HTML pages: Kubernetes HPA docs, Stack Overflow answer, GitHub issue.
- A `fixtures/queries.json` file with the "5 queries that prove hybrid > keyword":
  - "auto scale pods" → must rank HPA docs above an SO post that literally contains "auto-scale"
  - "react server-side hydration error" → must find an issue saying "hydration mismatch" without the words "server-side"
  - 3 more added during M5.

### Coverage target

- ≥80% on `lib/` and `worker/services/`. UI components are not coverage-mandated.

## 11. Repository layout

```
DevRecall/
├── manifest.config.ts          # generated manifest (TS) → manifest.json
├── package.json
├── tsconfig.json
├── vite.config.ts              # @crxjs/vite-plugin
├── vitest.config.ts
├── playwright.config.ts
├── tailwind.config.ts
├── .eslintrc.cjs
├── README.md
├── docs/superpowers/specs/
├── public/icons/               # 16/32/48/128 png
├── fixtures/
│   ├── pages/
│   └── queries.json
└── src/
    ├── popup/
    │   ├── index.html
    │   ├── main.tsx
    │   └── Popup.tsx
    ├── sidepanel/
    │   ├── index.html
    │   ├── main.tsx
    │   ├── App.tsx
    │   └── views/              # SearchView, LibraryView, DetailView
    ├── options/
    │   ├── index.html
    │   ├── main.tsx
    │   └── Options.tsx
    ├── content/
    │   └── extract.ts          # injected via chrome.scripting
    ├── worker/
    │   ├── index.ts            # service worker entry: message dispatcher
    │   ├── services/
    │   │   ├── CaptureService.ts
    │   │   ├── RetrievalService.ts
    │   │   └── SettingsService.ts
    │   ├── repository/
    │   │   ├── db.ts           # Dexie schema
    │   │   ├── PageRepo.ts
    │   │   └── ChunkRepo.ts
    │   └── llm/
    │       ├── LLMProvider.ts  # interface
    │       ├── OpenAIProvider.ts
    │       └── MockLLMProvider.ts
    ├── lib/                    # pure logic; no chrome.* or DOM
    │   ├── chunking.ts
    │   ├── bm25.ts
    │   ├── vector.ts
    │   ├── rrf.ts
    │   ├── urlNormalize.ts
    │   ├── readability.ts      # thin wrapper over @mozilla/readability
    │   └── log.ts
    ├── shared/
    │   ├── types.ts            # PageRecord, ChunkRecord, etc.
    │   ├── messages.ts         # DevRecallRequest/Response unions
    │   └── errors.ts           # DevRecallError + codes
    └── ui/
        ├── components/         # PageCard, Chip, Toast, etc.
        ├── hooks/              # useWorker, usePages, useSearch
        └── styles.css          # tailwind base
```

## 12. Build & CI

- `pnpm dev` → Vite with `@crxjs/vite-plugin`. HMR for popup/side panel/options; worker + content script rebuild on save.
- `pnpm build` → `dist/` ready for "Load unpacked" or zip.
- `pnpm test` → Vitest.
- `pnpm test:e2e` → Playwright.
- `pnpm lint`, `pnpm typecheck`.

### CI

One GitHub Actions workflow on PR + main: install (pnpm), typecheck, lint, test, build. No deployment step.

## 13. Stack

- **Language:** TypeScript (strict).
- **UI:** React 18.
- **Build:** Vite + `@crxjs/vite-plugin`.
- **Styling:** Tailwind CSS.
- **State:** none beyond `useState` + a tiny IndexedDB hook (Zustand later only if measured pain).
- **DB:** Dexie over IndexedDB.
- **HTML extraction:** `@mozilla/readability`.
- **Tokenization:** `js-tiktoken`.
- **Tests:** Vitest, `fake-indexeddb`, Playwright.
- **Lint:** ESLint + Prettier (typescript-eslint).
- **Package manager:** pnpm.
- **LLM API:** OpenAI — `gpt-4o-mini` for summaries/tags, `text-embedding-3-small` for embeddings. Behind a `LLMProvider` interface so future providers (Anthropic, Ollama, Transformers.js) are a 1-file addition.

## 14. Milestones

Six commits' worth of meaningful checkpoints, each independently demoable.

| #   | Milestone                         | What works at the end                                                                                                                                     |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Skeleton**                      | Extension loads. Popup, side panel, options open. No real functionality. Manifest, build, lint, test pipeline all green.                                  |
| M2  | **Capture (manual)**              | Click Save in popup → row in IndexedDB with title, URL, fullText. No LLM yet. Library view in side panel lists saved rows.                                |
| M3  | **LLM tagging + summary**         | Save generates summary, sourceType, topics, technologies, intent via `OpenAIProvider`. Pending/ready/failed states visible. Options page accepts API key. |
| M4  | **Keyword search**                | Side panel search box runs BM25 over chunks-of-fullText (simple chunking, no embeddings yet). Results show match highlighting.                            |
| M5  | **Embeddings + hybrid retrieval** | Real token-based chunking; embeddings stored; vector search; RRF fusion; "matched by meaning" badge. The 5 hybrid-vs-keyword test queries pass.           |
| M6  | **Polish + auto-save + ship**     | Allowlist auto-save on technical domains. Export-all-data. Detail view. Dark-mode pass. README with demo GIF. v1.0 tag.                                   |

Estimated effort: M1–M3 each ≈ one weekend; M4–M5 each ≈ one weekend; M6 ≈ one weekend. Total ≈ 6 weekends.

## 15. Out of scope for v1.0 (designed-for, deferred)

- **v1.1** — RAG-generated answers using the v1.0 retrieval as input. Worker already has the chunks and LLM client; this is one prompt + one component.
- **v1.1** — User-editable allowlist UI.
- **v1.2+** — Local embedding models via Transformers.js / WebGPU (Phase 5 of the original proposal).
- **v1.2+** — Chrome Web Store launch (privacy policy, store listing, BYO-API-key onboarding).
- **Indefinitely** — sync, screenshots, knowledge graphs, encryption-at-rest, Notion export.
