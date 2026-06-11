# DevRecall

DevRecall is a local-first Chrome extension that captures technical pages, summarizes and tags them via an LLM, and lets you retrieve your saved library through hybrid keyword and semantic search. All data stays in your browser's IndexedDB — nothing is synced to a server.

<!-- TODO: record a 60s demo GIF and save it to docs/demo.gif -->

![DevRecall demo](docs/demo.gif)

---

## Requirements

- Node.js 20+
- pnpm 9+
- Chrome or Chromium with extension developer mode enabled
- An OpenAI API key (required for LLM summarization/tagging and semantic search; keyword search works without one)

> The API key is stored in `chrome.storage.local` inside your browser profile. It is never written to disk in this repository and is never committed.

---

## Install and build

```bash
pnpm install
pnpm build
```

`pnpm build` runs a TypeScript check and then Vite, writing the extension bundle to `/dist`.

---

## Load the unpacked extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `/dist` directory in this repository.
5. Pin the DevRecall icon to the toolbar.
6. Open the popup, side panel, and options page to verify the extension loaded correctly.

---

## Usage

### Set your API key

Open the extension options page (click **Settings** in the side panel, or right-click the toolbar icon and choose **Options**). Paste your OpenAI API key and click **Save**. Use **Test connection** to verify the key works.

Keyword search works without a key. LLM summarization, topic tagging, and semantic ("matched by meaning") search require a valid key.

### Save a page manually

Click the DevRecall toolbar icon to open the popup, then click **Save this page**. The popup shows live status:

- **Saving…** — capture in progress
- **Processing…** — LLM summarization running in the background (polls every 2 s)
- **Saved ✓ Xm ago** — page is ready in your library
- **Save failed — try again** — the save or LLM step failed; click the button to retry

If no API key is configured, the save button is disabled and a prompt appears to set one in settings.

### Auto-save on technical domains

DevRecall automatically saves pages after you have been on them for at least 30 seconds, but only on a fixed set of technical domains:

- GitHub (`github.com`)
- Stack Overflow (`stackoverflow.com`)
- MDN Web Docs (`developer.mozilla.org`)
- Any subdomain whose hostname starts with `docs.`
- ReadTheDocs sites (`*.readthedocs.io`)
- npm (`npmjs.com`)
- Rust (`rust-lang.org`)
- Python (`python.org`)

Navigating away or closing the tab before the 30-second dwell elapses cancels the timer. Pages already in your library (status `ready`) are skipped automatically.

### Search and browse (side panel)

Click **Open library** in the popup, or use the keyboard shortcut **⌘ Shift K** / **Ctrl Shift K**, to open the side panel.

Type a query to run a live hybrid search (BM25 keyword + vector cosine, fused with RRF). Each result shows a match-reason badge:

- **keyword** — matched by BM25 term overlap
- **matched by meaning** — matched by vector similarity (semantic)
- **keyword + meaning** — matched by both arms

Use the filter chips to narrow results by source type: **All**, **Docs**, **SO** (Stack Overflow), **GH** (GitHub).

When no query is active, the panel shows your full library in reverse-chronological order, respecting the same filter chips. Each card has a **Delete** button to remove the page permanently.

Failed saves show a **Retry** button on their library card.

### Options

| Action           | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| Set API key      | Paste an OpenAI key; stored in `chrome.storage.local`, never committed     |
| Test connection  | Makes a minimal OpenAI call to validate the key                            |
| Storage stats    | Shows saved page count and total text size                                 |
| Re-index library | Re-generates embeddings for pages that are missing them (requires API key) |
| Export Data      | Downloads all saved pages as `devrecall-export.json`                       |
| Delete All Data  | Permanently removes every saved page (with confirmation prompt)            |

### Dark mode

The UI follows your OS color scheme automatically via Tailwind's `dark:` variants. No manual toggle is needed.

---

## Development commands

```bash
pnpm install        # Install dependencies
pnpm dev            # Start Vite dev server at http://127.0.0.1:5173
pnpm build          # TypeScript check + production build → /dist
pnpm typecheck      # TypeScript only (no build output)
pnpm lint           # ESLint
pnpm test           # Run all tests once
pnpm test:watch     # Run tests in watch mode
pnpm test --coverage  # Run tests with coverage report
```

---

## Architecture overview

Five loosely coupled components communicate via typed Chrome RPC:

```
Content Script → Service Worker ← Popup
                      ↓
                 IndexedDB (Dexie)
                 OpenAI API
                      ↑
                 Side Panel / Options
```

Key files:

- `src/worker/index.ts` — service worker; single writer to IndexedDB; hosts all business logic
- `src/worker/services/AutoSaveService.ts` — alarm-driven dwell timer for auto-save
- `src/worker/services/RetrievalService.ts` — hybrid BM25 + vector + RRF search
- `src/shared/messages.ts` — typed RPC request/response contract
- `src/shared/types.ts` — shared domain types (`PageRecord`, `PageHit`, etc.)

See `CLAUDE.md` for a detailed architecture reference and `docs/superpowers/specs/2026-05-16-devrecall-mvp-design.md` for the full MVP design.
