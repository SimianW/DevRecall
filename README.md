# DevRecall

DevRecall is a local-first Chrome extension that captures technical browsing sessions, summarizes and tags saved pages, and lets developers retrieve past documentation, GitHub issues, Stack Overflow answers, and debugging notes through natural-language search.

## Status

Current milestone: M1 Skeleton.

The extension shell loads the popup, side panel, options page, and background service worker. Capture, summarization, search, and export are scoped to later milestones.

## Development

Requirements:

- Node.js 20 or newer
- pnpm 9 or newer
- Chrome or Chromium with extension developer mode enabled

Install dependencies:

```bash
pnpm install
```

Run checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Build the extension:

```bash
pnpm build
```

Load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select the `dist/` directory from this repository.
5. Pin DevRecall, open the popup, open the side panel, and open the extension options page.

## Specification

The reviewed MVP design lives at `docs/superpowers/specs/2026-05-16-devrecall-mvp-design.md`.
