# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DevRecall is a local-first Chrome extension that captures technical pages and retrieves them with BM25 or optional Hybrid search. Saving and keyword search require no API key. OpenAI summaries, tags, and embeddings run only through effective Hybrid mode or an explicit user action. **M1–M6, the pre-v1.0 refactor, and issues #10–#21 are complete.** Remaining for v1.0: manual E2E QA, demo GIF, version → `1.0.0.0`, tag `v1.0`.

**Key Technologies:** React 18, TypeScript 6, Vite, Vitest, Dexie (IndexedDB), Chrome MV3, Tailwind CSS

## Project Conventions & Gotchas

- **This project is built with the Superpowers workflow.** Use its skills for every process. Specs and plans live in `docs/superpowers/`. Invoke the matching skill _before_ each phase: `brainstorming` (any new feature/design), `writing-plans` (multi-step work), `test-driven-development` (all code, tests first), `systematic-debugging` (any bug/failure), `executing-plans` / `subagent-driven-development` (running a written plan), `verification-before-completion` (before claiming done), `requesting-code-review` (before merge).
- **Version bump on every code change.** Bump `version` in `package.json` and `APP_VERSION` in `src/shared/messages.ts` (4-part `X.Y.Z.N`, must match), then commit.
- **MV3 service worker is killed after ~30s idle; in-memory globals are lost.** Never use `setTimeout`/`setInterval` for delayed work in the worker. Use `chrome.alarms` + `chrome.storage.session` and register `onAlarm` at top level. `AutoSaveService` is the reference implementation.
- **Auto-save is opt-in and OFF by default** (privacy). The flag lives in `chrome.storage.local` (`ChromeAutoSaveSettingStore`); the domain allowlist is in `src/shared/allowlist.ts` (shared so Options can render it). The enabled check is the FIRST gate in `AutoSaveService.startDwell`.
- **Local-only is a hard privacy boundary.** It never sends page content or search queries to OpenAI automatically, even if a key exists. Explicit **Add AI features** and confirmed bulk operations may send content while Local-only is selected because those actions are direct consent.
- **Stored and effective modes are different.** `src/shared/modes.ts` defines both. A missing key forces the effective mode to `local` but never overwrites a stored `hybrid` preference. `keyword_fallback` describes one completed search and is never stored.
- **Retrieval has Local-only and Hybrid paths.** Local-only is BM25. Hybrid creates a query embedding and combines BM25 with vector cosine through RRF; `MIN_VECTOR_SCORE` (0.4) gates vector hits. If query embedding fails, return the BM25 results with `searchMode: "keyword_fallback"`.
- **Semantic re-index is not metadata enrichment.** It repairs missing or stale embeddings and only replaces token chunks and embeddings. BM25 `tokenize()` (`src/lib/bm25.ts`) runs at query time, so tokenizer changes need no re-index.
- **Paid bulk work is confirmed, sequential, and cancellable.** `BulkTaskRunner` processes one page at a time and checks that work may continue before each page. Its queue stays in memory so a worker restart cannot replay paid requests.
- **Capture reads all frames.** The content script injects `all_frames`; `ChromePageExtractor` keeps the richest frame's body but anchors url/title to the top frame. Readability intentionally drops trailing reference/citation lists.
- **Integration/measurement tests that call OpenAI are skipped unless `OPENAI_API_KEY` is set** (CI-safe).

## Development Setup

### Requirements

- Node.js 20+
- pnpm 9+
- Chrome/Chromium with extension developer mode

### Common Commands

```bash
# Install dependencies
pnpm install

# Development and quality checks
pnpm dev          # Start dev server (http://127.0.0.1:5173)
pnpm build        # TypeScript check + Vite build
pnpm typecheck    # TypeScript only
pnpm lint         # ESLint
pnpm format       # Prettier format
pnpm format:check # Check formatting without changes

# Testing
pnpm test         # Run all tests once
pnpm test:watch   # Run tests in watch mode
pnpm test src/lib/urlNormalize.test.ts  # Single test file
```

### Loading the Extension Locally

1. Run `pnpm build` to generate `/dist`
2. Open `chrome://extensions`
3. Enable Developer mode (top right)
4. Click "Load unpacked"
5. Select the `/dist` directory
6. Pin the extension; open the side panel and options page to verify

## Architecture

### Four-Component Design

The extension is structured as four loosely coupled components communicating via **typed RPC** (chrome.runtime.sendMessage with discriminated-union request/response types):

```
Content Script → Service Worker ← Side Panel / Options
                      ↓
                 Database (Dexie)
                 LLM Provider (OpenAI)
```

#### 1. **Service Worker** (`src/worker/index.ts`)

- The single source of truth for all business logic and state mutations
- Hosts `CaptureService`, `RetrievalService`, `BulkTaskRunner`, `AutoSaveService`, repositories, setting stores, and `OpenAIProvider`
- Dispatches all `chrome.runtime` messages through a typed request handler
- Only writer to IndexedDB (no write/write races)
- May be killed mid-operation by Chrome's MV3 lifecycle; all state is rebuildable from the database
- Registers `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`; the toolbar icon opens the side panel directly, with no popup

**Key file.** Read `/src/worker/handlers.ts` first to understand request and response flow. `/src/worker/index.ts` is the thin MV3 entry with composition and listeners.

#### 2. **Content Script** (`src/content/extract.ts`)

- Stateless; injected on-demand by CaptureService
- Uses `@mozilla/readability` to extract main text from any page
- Returns `{ url, title, fullText, readingTimeMs }`
- Discards tracking parameters (utm\_\*, gclid, fbclid) and URL fragments during extraction

#### 3. **Side Panel** (`src/sidepanel/App.tsx`)

- Main discovery UI with Local-only BM25 and optional Hybrid search
- Hosts the "Save to library" bar (active tab title/domain + live save status via worker broadcasts)
- Lists saved pages with filters based on `platform` and `contentType`
- Offers explicit per-page **Add AI features** on `keyword_ready` records
- Shows loading and empty states
- All data flows through worker via typed messages

#### 4. **Options Page** (`src/options/Options.tsx`)

- API key management (stored in `chrome.storage.local`, not IndexedDB)
- Stored/effective search mode controls
- Connection testing (minimal OpenAI call to validate key)
- Storage stats display (page count, total text bytes)
- Auto-save toggle (opt-in, off by default; allowlisted domains shown)
- Confirmed, cancellable bulk AI enrichment and semantic re-index actions

### Data Model

**PageRecord** (Dexie table `pages`)

- `id`: ULID (sortable, URL-safe)
- `url`: normalized canonical URL
- `urlHash`: SHA-256(url), indexed for deduplication
- `title`, `domain`, `fullText`: extracted from page
- `platform`: where the content lives, classified locally from the URL
- `contentType`: what the content is, classified locally and optionally refined during enrichment
- `summary`, `topics`, `technologies`, `intent`: empty until LLM processing completes
- `status`: `pending` | `keyword_ready` | `enriching` | `ready` | `failed`
- `enrichmentError`: last OpenAI failure; the page remains `keyword_ready`
- `savedAt`, `visitedAt`, `readingTimeMs`, `saveMode`: metadata
- `schemaVersion: 1`: record format version

**ChunkRecord** (Dexie table `chunks`)

- Local saves write word chunks without embeddings for immediate BM25 search
- Enrichment replaces them atomically with token chunks, `Float32Array` embeddings, `embeddingModel`, and `indexVersion`
- Deleted together with their page (`PageRepo.deleteWithChunks` / `deleteAll` are transactional)

**Dexie schema** (`src/worker/repository/db.ts`):

```
pages:  '&id, urlHash, savedAt, domain, platform, contentType, status, [platform+savedAt], [contentType+savedAt]'
chunks: '&id, pageId, [pageId+ordinal]'
```

- Primary key `id` for direct lookups
- `urlHash` for O(1) dedup checks
- Compound indexes support filtered library views ordered by save time

**API Key Storage**

- Kept in `chrome.storage.local` (not IndexedDB) for defense-in-depth isolation from content scripts
- Retrieved/set via `ChromeApiKeyStore` interface
- Optional for save and BM25 search
- Required for AI enrichment, semantic re-index, and Hybrid query embeddings

### Capture Pipeline

1. The UI sends `page.save`; no API key gate applies.
2. `ChromePageExtractor` reads all frames and returns the richest body while preserving the top-frame URL and title.
3. `CaptureService.save` locally classifies `platform` and `contentType`, word-chunks the text, then calls `PageRepo.commitCapturedPage`.
4. One Dexie transaction writes the page as `pending`, replaces its BM25 chunks, flips it to `keyword_ready`, and commits before the RPC returns success.
5. Automatic enrichment runs only when the current effective mode is Hybrid and a usable key exists. `PageRepo.claimEnrichment` atomically claims `keyword_ready → enriching` before any OpenAI request.
6. Success atomically replaces chunks with embeddings and writes `ready`. An OpenAI failure restores `keyword_ready`, records `enrichmentError`, and preserves the local chunks. `failed` is reserved for a local save failure.

Non-failed records deduplicate by `urlHash`; a failed local save can be captured again. On startup, stale `enriching` records return to `keyword_ready` without replaying an OpenAI request.

**Explicit AI path:** `page.addAiFeatures` is direct consent to enrich one `keyword_ready` page, including while Local-only is selected. Bulk enrichment requires confirmation, uses `BulkTaskRunner`, and is cancellable between pages.

**Semantic re-index path:** the confirmed bulk action selects `ready` pages with missing embeddings, a stale embedding model, or a stale index version. It sends chunks for embedding and changes no page metadata.

**Auto-save path:** auto-save is opt-in and allowlisted. `chrome.tabs` events start a 30 second `chrome.alarms` dwell timer. The local BM25 save always runs first. Effective Local-only mode sends nothing to OpenAI; effective Hybrid may enrich after the local transaction commits.

### Typed RPC Contract

All extension messages use a single discriminated-union pattern:

```typescript
// requests from UI → worker
type DevRecallRequest =
  | { type: "page.save"; payload: { tabId: number } }
  | { type: "page.list"; payload: { limit: number } }
  | { type: "page.addAiFeatures"; payload: { pageId: string } }
  | { type: "search.run"; payload: { query: string; topK?: number } }
  | { type: "settings.getStatus" }
  | { type: "settings.setApiKey"; payload: { apiKey: string } }
  | { type: "settings.setMode"; payload: { mode: StoredMode } }
  | { type: "library.bulkEnrich"; payload: Record<string, never> }
  | { type: "library.reindexSemantic"; payload: Record<string, never> }
  | { type: "library.cancelBulk"; payload: Record<string, never> }
  | ...

// responses from worker → UI
type DevRecallResponse =
  | { type: "page.saved"; payload: { page: PageListItem } }
  | { type: "page.listed"; payload: { pages: PageListItem[] } }
  | { type: "settings.status"; payload: { hasApiKey: boolean; storedMode: StoredMode; effectiveMode: EffectiveMode } }
  | { type: "search.results"; payload: { results: PageHit[]; searchMode: SearchMode } }
  | ...
  | { type: "error"; payload: { message: string } }
```

RPC types live in `/src/shared/messages.ts`; domain and mode types live in `/src/shared/types.ts` and `/src/shared/modes.ts`.

### URL Normalization

`src/lib/urlNormalize.ts` handles deduplication:

- Removes fragment (`#...`)
- Removes tracking parameters (utm\_\*, gclid, fbclid)
- Sorts remaining query params for canonical ordering
- Returns normalized URL, SHA-256 hash, and domain

This ensures the same technical content viewed multiple times is stored once.

## Testing Strategy

**Coverage targets** (configured in `vitest.config.ts`):

- `src/lib/**/*.ts` (utilities: URL normalization, etc.)
- `src/worker/handlers.ts` (message dispatcher: handleMessage, handleRequest)
- `src/worker/services/**/*.ts` (CaptureService, etc.)
- `src/worker/llm/**/*.ts` (OpenAI provider)
- `src/worker/settings/**/*.ts` (API key store)

**Test setup** (`src/test/setup.ts`):

- Uses `jsdom` environment for DOM and Browser APIs
- `fake-indexeddb/auto` for in-memory Dexie testing
- `@testing-library/jest-dom/vitest` for DOM matchers

**Test patterns**:

- Unit tests for pure functions (URL normalization, response parsing)
- Integration tests for service classes with mocked dependencies
- React component tests with mocked worker communication

**Example**: `/src/content/extract.test.ts` tests `extractPage()` with jsdom and a mocked document.

## Code Organization

- `/src/shared/`: domain types, `modes.ts`, message contracts, enums, and the auto-save allowlist
- `/src/worker/`: service worker entry point and business logic
  - `handlers.ts`: typed RPC dispatcher, pure and unit-tested
  - `index.ts`: thin MV3 entry with composition and top-level listeners
  - `services/`: capture, retrieval, auto-save, and sequential bulk task logic
  - `llm/`: LLM provider interface and OpenAI implementation
  - `settings/`: API key, stored mode, and auto-save Chrome storage wrappers
  - `repository/db.ts`: Dexie schema definition and version
  - `repository/`: PageRepo queries
- `/src/sidepanel/`, `/src/options/`: React UI entry points; `sidepanel/SaveBar.tsx` is the save affordance
- `/src/ui/components/`: shared UI components
- `/src/ui/rpc.ts`: shared typed RPC client used by the UI
- `/src/content/`: content script entry point
- `/src/lib/`: utilities such as URL normalization
- `/docs/superpowers/specs/`: design documents

## Build & Config

- **Vite** (`vite.config.ts`): Entry points are the four HTML/TS files; CRX plugin handles manifest generation and MV3 bundling
- **Manifest** (`manifest.config.ts`): Defined as TypeScript, compiled to `/dist/manifest.json` by CRX plugin
- **TypeScript** (`tsconfig.json`): Strict mode, ES2022 target, ESNext modules
- **Linting** (`eslint.config.js`): ESLint + TypeScript rules; globals for Chrome APIs and test functions defined
- **Styling**: Tailwind CSS with CSS-variable color tokens (`foreground`/`surface`/`surface-raised`/`default`/`accent`, defined in `src/ui/styles.css` for light + media-based dark). Theme is "Warm Editorial": warm paper light / warm charcoal dark, terracotta accent, `font-serif` titles. Restyle by editing the variables, not component classes.

## Key Design Decisions

1. **All UI talks through the worker**: Single place to change schema, hold API key, and add RAG in v1.1.
2. **Service worker hosts retrieval**: Intentional surface to showcase MV3 lifecycle (worker may be killed mid-operation).
3. **Typed RPC over string messages**: Compile-time safety; no stringly-typed event soup.
4. **Keyword-first lifecycle**: The local transaction reaches `keyword_ready` before any optional network work. Only local persistence failures use `failed`.
5. **`fullText` stored in DB**: Re-chunking strategy may change; kept for future flexibility.
6. **Float32Array for embeddings**: 4× smaller than number[], 4× faster cosine similarity (powers the hybrid vector arm in `RetrievalService`).
7. **`urlHash` for dedup**: O(1) lookup; `url` not separately indexed.
8. **Independent `platform` and `contentType`**: Filters do not conflate where a page lives with what kind of page it is.
9. **Stored/effective mode split**: Key availability changes behavior without rewriting the user's preference.
10. **In-memory paid queues**: Cancellation is immediate between pages, and MV3 restart never replays queued OpenAI work.

## Specification

The reviewed MVP design is at `/docs/superpowers/specs/2026-05-16-devrecall-mvp-design.md`. Covers goals, success criteria, architecture, data model, capture pipeline, and retrieval design.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):

- Runs on main push and all PRs
- pnpm install → typecheck → lint → test → build

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default label names. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
