# DevRecall

DevRecall is a Chrome extension that helps you save useful technical pages and find them again when you need them.

## Demo

### Save a technical page locally

Open DevRecall from the Chrome toolbar and save the page you are viewing.

![Saving a technical page locally with DevRecall](docs/assets/save.gif)

### Find it later by keyword or meaning

Search your saved pages by keyword, or use Hybrid search to find a page by what it means.

![Searching saved pages with DevRecall](docs/assets/search.gif)

## What you can do

- Save documentation, GitHub pages, Stack Overflow answers, articles, and other technical references.
- Search your saved pages by keyword.
- Use optional AI features for summaries, topics, technologies, and meaning-based search.
- Turn on auto-save for common developer sites.
- Filter your library by site and content type.
- Export your library or delete it at any time.

## How it works

Open DevRecall from the Chrome toolbar. Save the page you are viewing, then use the side panel to search or browse your library.

Every page is saved locally first, so saving and keyword search work without an API key. If you want AI summaries or meaning-based search, add your own OpenAI API key in DevRecall's settings.

## Install from source

Requirements: Node.js 20 or newer, pnpm 9 or newer, and Chrome or Chromium.

```bash
pnpm install
pnpm build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository's `dist` directory. Click the DevRecall toolbar icon to open the side panel.

## Choose how DevRecall uses AI

**Local-only** keeps automatic saving and search on your device. DevRecall contacts OpenAI only when you choose an AI action for a saved page.

**Hybrid** adds AI summaries and meaning-based search when an OpenAI API key is available. Page content and search queries may be sent to OpenAI while you use these features.

If an AI request fails, your locally saved page and keyword search still work.

## Your data

DevRecall stores your library and API key in your browser profile. It does not have a separate account or sync service.

You stay in control of when AI features are used, and you can export or delete your saved data from the settings page.

## Development

```bash
pnpm dev          # Start the Vite development server
pnpm test         # Run the test suite once
pnpm typecheck    # Check TypeScript
pnpm lint         # Run ESLint
pnpm format:check # Check formatting
pnpm build        # Create the production extension in dist
```
