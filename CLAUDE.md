# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DevRecall is a local-first Chrome extension that captures technical browsing sessions, summarizes and tags saved pages, and lets developers retrieve past documentation through natural-language search. Currently at M1 (Skeleton) milestone with capture, tagging, and listing infrastructure in place.

**Key Technologies:** React 18, TypeScript 6, Vite, Vitest, Dexie (IndexedDB), Chrome MV3, Tailwind CSS

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
6. Pin the extension; open popup, side panel, and options page to verify

## Architecture

### Five-Component Design

The extension is structured as five loosely coupled components communicating via **typed RPC** (chrome.runtime.sendMessage with discriminated-union request/response types):

```
Content Script → Service Worker ← Popup
                      ↓
                 Database (Dexie)
                 LLM Provider (OpenAI)
                      ↑
                 Side Panel
```

#### 1. **Service Worker** (`src/worker/index.ts`)

- The single source of truth for all business logic and state mutations
- Hosts `CaptureService`, `PageRepo`, `ApiKeyStore`, and `OpenAIProvider`
- Dispatches all `chrome.runtime` messages through a typed request handler
- Only writer to IndexedDB (no write/write races)
- May be killed mid-operation by Chrome's MV3 lifecycle; all state is rebuildable from the database

**Key file:** `/src/worker/index.ts` — read this first to understand request/response flow.

#### 2. **Content Script** (`src/content/extract.ts`)

- Stateless; injected on-demand by CaptureService
- Uses `@mozilla/readability` to extract main text from any page
- Returns `{ url, title, fullText, readingTimeMs }`
- Discards tracking parameters (utm\_\*, gclid, fbclid) and URL fragments during extraction

#### 3. **Popup** (`src/popup/Popup.tsx`)

- Toolbar entry point ("Save this page" button)
- No direct database access
- Shows page save status (idle/saving/saved/failed/pending with retry)
- Polls worker for url status while processing is pending
- Opens the side panel

#### 4. **Side Panel** (`src/sidepanel/App.tsx`)

- Main discovery UI (search placeholder; future: hybrid retrieval)
- Lists saved pages with filters (All/Docs/SO/GH)
- Shows loading and empty states
- All data flows through worker via typed messages

#### 5. **Options Page** (`src/options/Options.tsx`)

- API key management (stored in `chrome.storage.local`, not IndexedDB)
- Connection testing (minimal OpenAI call to validate key)
- Storage stats display (page count, total text bytes)
- Auto-save toggle (UI placeholder; logic not yet implemented)

### Data Model

**PageRecord** (Dexie table `pages`)

- `id`: ULID (sortable, URL-safe)
- `url`: normalized canonical URL
- `urlHash`: SHA-256(url), indexed for deduplication
- `title`, `domain`, `fullText`: extracted from page
- `sourceType`: initially "unknown"; set by LLM tagging
- `summary`, `topics`, `technologies`, `intent`: empty until LLM processing completes
- `status`: "pending" | "ready" | "failed" — differentiates pending saves from completed ones
- `savedAt`, `visitedAt`, `readingTimeMs`, `saveMode`: metadata
- `schemaVersion: 1` — enables future Dexie migrations

**Dexie Indexes:**

```
pages: '&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]'
```

- Primary key `id` for direct lookups
- `urlHash` for O(1) dedup checks
- `[sourceType+savedAt]` compound index for filtered library views

**API Key Storage**

- Kept in `chrome.storage.local` (not IndexedDB) for defense-in-depth isolation from content scripts
- Retrieved/set via `ChromeApiKeyStore` interface

### Capture Pipeline

1. **User clicks "Save this page"** → Popup sends `page.save` message to worker
2. **CaptureService.save(tabId)**
   - Calls `ChromePageExtractor.extract(tabId)` → content script extracts text
   - Calls `PageRepo.upsertCapturedPage(extracted)` → writes to DB with `status: "pending"`
   - Returns `PageListItem` to popup immediately
3. **Background LLM Processing** (async, non-blocking)
   - If API key is configured, worker calls `OpenAIProvider.summarizeAndTag()`
   - OpenAI response is parsed and validated; invalid fields default to safe values
   - Updates `PageRecord` with `status: "ready"` + summary/tags
   - On error, updates with `status: "failed"` + `errorReason`

### Typed RPC Contract

All extension messages use a single discriminated-union pattern:

```typescript
// requests from UI → worker
type DevRecallRequest =
  | { type: "page.save"; payload: { tabId: number } }
  | { type: "page.list"; payload: { limit: number } }
  | { type: "settings.getStatus" }
  | { type: "settings.setApiKey"; payload: { apiKey: string } }
  | { type: "settings.testConnection" }
  | { type: "storage.getStats" }
  | { type: "page.statusForUrl"; payload: { url: string } }
  | ...

// responses from worker → UI
type DevRecallResponse =
  | { type: "page.saved"; payload: { page: PageListItem } }
  | { type: "page.listed"; payload: { pages: PageListItem[] } }
  | { type: "settings.status"; payload: { hasApiKey: boolean } }
  | ...
  | { type: "error"; payload: { message: string } }
```

All types defined in `/src/shared/messages.ts` and `/src/shared/types.ts`.

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
- `src/worker/index.ts` (message dispatcher: handleMessage, handleRequest)
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

- `/src/shared/` — types and message contracts (read by all layers)
- `/src/worker/` — service worker entry point and business logic
  - `index.ts` — message handler dispatcher
  - `services/` — domain logic (CaptureService, etc.)
  - `llm/` — LLM provider interface and OpenAI implementation
  - `settings/` — API key store (Chrome storage wrapper)
  - `repository/db.ts` — Dexie schema definition and version (bump here for migrations)
  - `repository/` — PageRepo queries
- `/src/popup/`, `/src/sidepanel/`, `/src/options/` — UI entry points (React)
- `/src/ui/components/` — shared UI components (SurfaceShell, PageCard, etc.)
- `/src/content/` — content script entry point
- `/src/lib/` — utilities (URL normalization, etc.)
- `/docs/superpowers/specs/` — design documents

## Build & Config

- **Vite** (`vite.config.ts`): Entry points are the five HTML/TS files; CRX plugin handles manifest generation and MV3 bundling
- **Manifest** (`manifest.config.ts`): Defined as TypeScript, compiled to `/dist/manifest.json` by CRX plugin
- **TypeScript** (`tsconfig.json`): Strict mode, ES2022 target, ESNext modules
- **Linting** (`eslint.config.js`): ESLint + TypeScript rules; globals for Chrome APIs and test functions defined
- **Styling**: Tailwind CSS with custom colors (ink, panel, accent)

## Key Design Decisions

1. **All UI talks through the worker**: Single place to change schema, hold API key, and add RAG in v1.1.
2. **Service worker hosts retrieval**: Intentional surface to showcase MV3 lifecycle (worker may be killed mid-operation).
3. **Typed RPC over string messages**: Compile-time safety; no stringly-typed event soup.
4. **`status` field on pages**: Async capture requires pending/ready/failed states visible to UI.
5. **`fullText` stored in DB**: Re-chunking strategy may change; kept for future flexibility.
6. **Float32Array for embeddings**: 4× smaller than number[], 4× faster cosine similarity (prepared for v1.1 vector search).
7. **`urlHash` for dedup**: O(1) lookup; `url` not separately indexed.
8. **Compound index `[sourceType+savedAt]`**: Filtered library views avoid full O(n) scan.

## Specification

The reviewed MVP design is at `/docs/superpowers/specs/2026-05-16-devrecall-mvp-design.md`. Covers goals, success criteria, architecture, data model, capture pipeline, and retrieval design.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):

- Runs on main push and all PRs
- pnpm install → typecheck → lint → test → build
