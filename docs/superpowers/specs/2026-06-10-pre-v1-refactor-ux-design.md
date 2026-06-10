# Pre-v1.0 Refactor + UX Fixes — Design

**Date:** 2026-06-10
**Branch:** `worktree-M6-polish-auto-save-ship`
**Status:** Draft — pending user approval

## Goal

Before shipping v1.0, remove the structural duplication that has accumulated across
M1–M6 and close the top user-facing gaps — most importantly, that auto-save currently
runs against a hard-coded allowlist with **no user control** (the Options checkbox is
disabled decoration).

Scope decided with the user:

- Structure refactor + top UX fixes, then ship v1.0.
- Auto-save toggle is **off by default** for new installs.
- Deferred to v1.1 (YAGNI): user-editable allowlist, saved-date on cards,
  "no API key → no semantic search" hint.

## Part A — Structure

### A1. Shared typed RPC client (`src/ui/rpc.ts`)

Today `sidepanel/App.tsx` and `Options.tsx` (and the popup, until B2 removes it)
each hand-roll `default*` wrappers around `chrome.runtime.sendMessage` — every one
repeating the `typeof chrome === "undefined"` guard and the response-type check
(~150 duplicated lines).

New module with two exports:

- `sendRequest<T extends DevRecallResponse["type"]>(request: DevRecallRequest, expectedType: T): Promise<Extract<DevRecallResponse, { type: T }>["payload"] | null>`
  — handles the chrome guard, sends, validates the response discriminant, returns the
  typed payload (`null` when chrome is unavailable or the type mismatches; callers keep
  today's fail-soft behavior).
- `subscribeToBroadcasts(handler: (m: WorkerBroadcast) => void): () => void`
  — wraps listener add/remove with the same chrome guard.

The surfaces **keep their dependency-injection props** (test shape unchanged);
their `default*` functions collapse to one-liners over the client.

### A2. Split `src/worker/index.ts` (412 lines)

Two files, same behavior:

- `src/worker/handlers.ts` — port types (`CapturePort`, `PageListPort`, `SearchPort`),
  `HandlerDeps`, `handleRequest`, `handleMessage`. Pure and unit-testable; existing
  `index.test.ts` updates its import only.
- `src/worker/index.ts` — thin MV3 entry point: composition root (service wiring) and
  top-level Chrome listener registration (MV3 requires these at top level anyway).

Extract the thrice-duplicated "processPage → invalidate → broadcast" sequence
(`page.save`, `page.retry`, auto-save `saveAuto`) into one shared
`processPageInBackground(deps, pageId, apiKey)` helper.

### A3. Housekeeping

- Move `HANDOFF.md` → `docs/superpowers/handoffs/2026-06-01-m6.md`.
- Fix the stale "auto-save toggle is a UI placeholder" line in this branch's CLAUDE.md,
  and update its architecture section: the five-component design becomes four once the
  popup is removed (B2).

## Part B — UX

### B1. Real auto-save toggle (off by default)

- New `autoSaveEnabled` flag in `chrome.storage.local`, default `false`.
- Two new RPC messages: `settings.getAutoSave` / `settings.setAutoSave`
  (+ responses) in `src/shared/messages.ts`.
- `AutoSaveService` checks the flag **before starting any dwell timer**, so disabling
  stops new auto-saves immediately (an already-fired alarm for a running timer may
  still complete; acceptable).
- Options: the checkbox becomes functional and the eight allowlisted domains are
  listed beneath it so users see exactly what they're opting into.
- Existing installs flip from silently-on to off — the correct v1.0 reset.

### B2. Remove the popup — icon opens the side panel directly

The popup surface is removed entirely. Clicking the toolbar icon opens the side
panel, making it the single UI surface (plus Options).

- **Manifest/build:** remove `default_popup` from the action in `manifest.config.ts`
  and drop the popup entry point from `vite.config.ts`; delete `src/popup/`.
- **Worker:** call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
  at top level (Chrome's native icon→panel behavior; no `action.onClicked` handler
  needed).
- **Save moves to the side panel:** a "Save this page" button at the top of the panel
  (above search) saves the active tab. It shows the popup's current states —
  idle / Saving… / Processing… / Saved ✓ (relative time) / failed-with-retry — plus
  the active tab's title and domain so users can confirm what they're saving.
- **Status updates:** the panel already subscribes to worker broadcasts
  (`page.updated`), so save status updates live — the popup's 2-second polling loop
  is deleted, not ported.
- **Active-tab tracking:** the panel listens to `chrome.tabs.onActivated` /
  `onUpdated` to refresh the save-button target and status when the user switches
  tabs (the side panel persists across tab switches, unlike the popup).
- The panel's existing "Settings" button stays; the popup's "Open library" button is
  obsolete by construction.

### B3. Readable filter labels

Side panel chips become "All / Docs / Stack Overflow / GitHub" (was "SO" / "GH").

### B4. Visual restyle — "Warm Editorial" theme

Chosen via visual mockups (`.superpowers/brainstorm/`, options A/B/C; user picked C,
dark variant "Warm Charcoal"). DevRecall reads as a personal reading library rather
than a generic dev tool.

**Light theme (warm paper):**

- Surfaces: warm paper neutrals (Tailwind *stone* family) — page `#faf9f7`,
  raised cards `#fffdfa`, borders `#e7e2da`/`#efe9e0`.
- Accent: terracotta `#9a3412` (replaces blue `#2563eb`).
- Typography: serif stack (Georgia/`ui-serif`) for page/card **titles** only;
  Inter stays for body, metadata, and controls.
- Filters: rounded pill chips (filled terracotta when active, soft stone otherwise).

**Dark theme (warm charcoal, media-based as today):**

- Surfaces stay in the warm family: page `#1c1917`, raised `#262220`,
  borders `#33302c`; warm-gray text (`#e7e5e4` titles, `#a8a29e` body).
- Accent brightens for contrast: terracotta `#c2562c`.

**Implementation:** this is a token-level change — the existing CSS variables in
`src/ui/styles.css` (light + dark blocks) and the `accent` color in
`tailwind.config.js` carry most of it; add a `font-serif` title treatment and the
pill filter styling. Applies to the side panel and Options (the popup no longer
exists). Remove the now-unused `ink`/`panel` legacy colors if nothing references
them. Behavior tests are unaffected; contrast in both themes is checked during the
existing manual dark-mode QA pass in Task 6.

## Error handling

- `sendRequest` preserves current fail-soft semantics (return `null` / empty data)
  so no surface gains new failure modes.
- Auto-save flag read failures default to `false` (disabled) — safe direction.

## Testing

TDD throughout (project convention):

- `src/ui/rpc.test.ts` — guard behavior, type mismatch, broadcast subscribe/unsubscribe.
- `AutoSaveService.test.ts` — no dwell timer when flag is off; timer when on.
- `Options.test.tsx` — toggle reads/writes the flag; allowlist rendered.
- `App.test.tsx` (side panel) — save button states (idle/saving/processing/saved/
  failed+retry), active-tab title/domain rendering, status refresh on tab switch.
- `Popup.test.tsx` deleted with the popup.
- Existing worker tests move with `handlers.ts`; behavior unchanged.

Version bump (`package.json` + `APP_VERSION`) per change, per project rule.

## After this lands

Task 6 ship steps proceed as planned: demo GIF, manual E2E (incl. auto-save +
dark-mode QA), version → `1.0.0.0`, tag `v1.0`.
