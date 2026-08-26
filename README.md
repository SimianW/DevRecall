# DevRecall

DevRecall is a local-first Chrome extension for saving and finding technical pages. Every save gets a local BM25 index immediately, so capture and keyword search work without an OpenAI API key. AI summaries, tags, embeddings, and semantic search are optional.

Saved pages and indexes stay in browser storage. DevRecall sends data to OpenAI only in the cases listed under [Privacy and OpenAI](#privacy-and-openai).

<!-- TODO: record a 60s demo GIF and save it to docs/demo.gif -->

![DevRecall demo](docs/demo.gif)

## Requirements

- Node.js 20+
- pnpm 9+
- Chrome or Chromium with extension developer mode enabled
- An OpenAI API key only if you want AI features or semantic search

## Install and build

```bash
pnpm install
pnpm build
```

`pnpm build` runs the TypeScript check and Vite, then writes the extension bundle to `/dist`.

## Load the unpacked extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `/dist` directory in this repository.
5. Pin the DevRecall icon to the toolbar.
6. Open the side panel and Options to check the installation.

## Usage

### Choose a search mode

Options has two stored preferences:

- **Local-only** uses BM25 and never contacts OpenAI automatically, even when a key is saved. Pages stay in this browser. DevRecall uses keyword search and does not automatically contact OpenAI. Content is sent to OpenAI only when you explicitly choose Add AI features for one or more saved pages.
- **Hybrid** combines BM25 and vector similarity through RRF when a usable key is available.

The stored preference and effective mode are separate. If Hybrid is stored but no usable key exists, the effective mode becomes Local-only without overwriting the Hybrid preference. Adding a key restores Hybrid on the next operation. If semantic query embedding fails during a Hybrid search, that search returns BM25 results as a keyword fallback.

### Save a page

Click the DevRecall toolbar icon to open the side panel, then click **Save to library**. No API key is required. The worker extracts the page, classifies its `platform` and `contentType` locally, and commits the page plus its BM25 chunks in one IndexedDB transaction.

The page lifecycle is:

```text
pending -> keyword_ready -> enriching -> ready
```

- `pending` exists only while the local page and keyword chunks are being written.
- `keyword_ready` is saved locally and searchable with BM25.
- `enriching` means an approved OpenAI request is in flight.
- `ready` has AI metadata and embeddings in addition to the local index.
- `failed` is reserved for a local persistence failure. An OpenAI failure returns the page to `keyword_ready`, records `enrichmentError`, and keeps BM25 search working.

Repeated saves deduplicate `pending`, `keyword_ready`, `enriching`, and `ready` records. A `failed` local save can be tried again.

### Add AI features

A `keyword_ready` page has an **Add AI features** action. With a saved key, this explicitly sends that page's text to OpenAI for a summary, topics, technologies, content type refinement, and embeddings. This action is available in Local-only mode because the click is explicit consent. A failed enrichment can be retried from the same card.

Options can apply the same action to every eligible local page. DevRecall shows a confirmation first, then processes pages sequentially. The progress panel reports completed, failed, and remaining pages. You can cancel between pages. Removing the key, switching to Local-only, worker shutdown, or pressing **Cancel** prevents queued paid work from continuing; the worker never replays the queue automatically.

**Active processing behavior:** Turning on Local-only lets the request already sent finish, then stops all queued and automatic OpenAI requests. Unprocessed pages remain `keyword_ready`.

### Auto-save

Auto-save is opt-in and off by default. When enabled, it saves a page after a 30 second dwell on the fixed allowlist:

- GitHub (`github.com`)
- Stack Overflow (`stackoverflow.com`)
- MDN Web Docs (`developer.mozilla.org`)
- Hosts beginning with `docs.`
- ReadTheDocs (`*.readthedocs.io`)
- npm (`npmjs.com`)
- Rust (`rust-lang.org`)
- Python (`python.org`)

Navigating away or closing the tab cancels the dwell timer. Auto-save always completes the local BM25 save first. In effective Local-only mode it makes no OpenAI request. In effective Hybrid mode it may start enrichment after the local save succeeds.

### Search and browse

Click the toolbar icon or use **Cmd Shift K** / **Ctrl Shift K** to open the side panel. Type a query to search the library.

- Local-only sends no query to OpenAI and searches BM25 chunks in IndexedDB.
- Hybrid sends the query to OpenAI to create a query embedding, then combines BM25 and vector results.
- Keyword fallback means a Hybrid semantic request failed and the displayed results came from BM25 only.

Result badges distinguish keyword, semantic, and combined matches. Filters use the independent `platform` and `contentType` fields, including Docs, Stack Overflow, and GitHub. With no active query, the panel lists saved pages newest first.

### Re-index semantic search

Semantic re-index is separate from AI metadata enrichment. Options shows the number of pages whose embeddings are missing or stale and requires confirmation before starting. It sends relevant page chunks to OpenAI, processes pages sequentially, and can be canceled between pages. It updates token chunks and embeddings only. Existing summaries, topics, technologies, platforms, content types, and intent stay unchanged.

### Privacy and OpenAI

The API key lives in `chrome.storage.local` inside the browser profile. DevRecall has no sync service.

DevRecall sends page content to OpenAI only when one of these conditions applies:

- Effective Hybrid mode automatically enriches a newly saved manual or auto-saved page.
- You click **Add AI features** for one page.
- You confirm bulk **Add AI features to local pages**.
- You confirm **Re-index semantic search**, which sends relevant chunks for embeddings.

DevRecall sends a search query to OpenAI only for an effective Hybrid search. Local-only capture, auto-save, browsing, and BM25 search make no OpenAI request.

### Other Options actions

| Action          | Description                                                         |
| --------------- | ------------------------------------------------------------------- |
| Set API key     | Saves an OpenAI key in `chrome.storage.local`                       |
| Test connection | Makes a minimal OpenAI request                                      |
| Storage stats   | Shows page count, local text size, and semantic re-index candidates |
| Export data     | Downloads saved records as `devrecall-export.json`                  |
| Delete all data | Removes every saved page and chunk after a confirmation             |

The UI follows the operating system color scheme.

## Development commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start Vite at http://127.0.0.1:5173
pnpm build            # TypeScript check and production build to /dist
pnpm typecheck        # TypeScript only
pnpm lint             # ESLint
pnpm test             # Run all tests once
pnpm test:watch       # Run tests in watch mode
pnpm test --coverage  # Run tests with coverage
```

## Architecture overview

Four components communicate through typed Chrome RPC:

```text
Content Script -> Service Worker <- Side Panel / Options
                      |
                 IndexedDB (Dexie)
                 OpenAI API
```

Key files:

- `src/worker/handlers.ts`: typed RPC dispatcher and privacy gates
- `src/worker/index.ts`: MV3 composition and top-level listeners
- `src/worker/services/CaptureService.ts`: atomic local capture and enrichment state machine
- `src/worker/services/RetrievalService.ts`: Local-only and Hybrid retrieval
- `src/worker/services/BulkTaskRunner.ts`: sequential, cancellable paid work queues
- `src/worker/services/AutoSaveService.ts`: alarm-driven allowlisted auto-save
- `src/worker/settings/ModeStore.ts`: stored and effective mode resolution
- `src/shared/modes.ts`: shared `StoredMode`, `EffectiveMode`, and per-search `SearchMode` types
- `src/shared/messages.ts`: typed RPC and worker broadcast contracts
- `src/shared/types.ts`: `PageRecord`, `ChunkRecord`, and search result types

See `CLAUDE.md` for the detailed architecture reference and `docs/superpowers/specs/2026-05-16-devrecall-mvp-design.md` for the original MVP design.
