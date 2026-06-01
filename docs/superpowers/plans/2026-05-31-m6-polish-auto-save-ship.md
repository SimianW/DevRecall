# M6 — Polish, Auto-save, and Ship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish v1.0 by shipping the M6 polish pass: allowlist auto-save on technical domains, export-all-data, detail-view cleanup, dark-mode polish, filter-chip wiring, retry UX for failed pages, a README + demo GIF, and the final release/tag. This plan also includes the retrieval-quality stemming task surfaced during M5 hardening.

**Architecture:** M6 is the last planned milestone before v1.0. It builds on the merged M5 stack (token chunking, embeddings, hybrid retrieval, live refresh, delete/re-index, meaning badges) and closes the product loop: background auto-save driven by tab dwell time, explicit data export and delete-all flows, a polished page detail view, a final visual pass, and release packaging. Retrieval-quality cleanup happens in `lib/bm25.ts`: stem Latin tokens in the shared tokenizer so query and document normalization stay in lockstep.

**Tech Stack:** TypeScript strict mode, React 18, Chrome MV3 (`tabs`, `commands`, `sidePanel`, `runtime` messaging), Dexie, Vitest, Testing Library, Tailwind CSS.

**Parent spec:** [`docs/superpowers/specs/2026-05-16-devrecall-mvp-design.md`](../specs/2026-05-16-devrecall-mvp-design.md) — §6.1 (auto-save), §6.2 (delete flow), §7 (retrieval), §8 (surfaces), §10 (testing), §14 (milestones), §15 (v1.1+ out of scope).

**Reference notes:** [`HANDOFF.md`](../../../HANDOFF.md) — stemming task, threshold note, and the current M6 wording.

**Depends on:** M5 merged and green (hybrid retrieval, live refresh, delete/re-index, meaning badges, CJK keyword support).

---

## Scope

M6 delivers the final MVP polish and ship items:

- English stemming inside `src/lib/bm25.ts` so `stakeholder` matches `stakeholders`, `reporting` matches `report`, and similar morphology gaps close without touching CJK tokenization.
- Allowlist auto-save on technical domains with a **`chrome.alarms`-based** 30s dwell timer (NOT `setTimeout` — see Task 2), cancel-on-tab-switch/navigation, dedup against already-saved pages, and the hard-coded v1.0 allowlist from the parent spec.
- Export-all-data from Options as a JSON download of the local library state (include `schemaVersion` for forward-compat, even though import is v1.1+).
- Detail-view polish: summary, chips, timestamps, retry action for failed saves, and a cleaner entry point for single-page delete. **Scope = polishing the existing expandable `PageCard`, not building a new routed detail page** (a separate view would be its own task).
- **[M6 extension, beyond spec §14]** Filter-chip wiring so source-type chips actually filter the library/search surface instead of staying decorative.
- **[M6 extension, beyond spec §14]** Delete-all-data with confirmation from Options, using the same transactional guarantees as single-page delete.
- Dark-mode pass across popup, side panel, options, cards, and empty/loading states.
- README install/run docs plus a short demo GIF.
- Final version bump and `v1.0` tag.

Out of scope (v1.1+):

- RAG-generated answers.
- User-editable allowlist UI.
- Local embedding models via Transformers.js / WebGPU.
- Chrome Web Store launch work.
- ANN indexes / heavier retrieval infrastructure.

Baseline before plan creation:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all pass with M5 merged.

## File Structure

- Modify `src/lib/bm25.ts` and `src/lib/bm25.test.ts` — English stemming in the Latin token path.
- Modify `src/worker/services/CaptureService.ts` and `src/worker/services/CaptureService.test.ts` — allowlist auto-save dwell timer and retry-aware save flow.
- Modify `src/worker/index.ts` and `src/worker/index.test.ts` — `tabs` listeners for auto-save, delete-all, export, and retry routing.
- Modify `src/worker/repository/PageRepo.ts`, `ChunkRepo.ts`, and their tests — export payloads, delete-all, and stats helpers.
- Modify `src/shared/messages.ts` and `src/shared/types.ts` — request/response contracts for export, delete-all, retry, and filter-state updates.
- Modify `src/sidepanel/App.tsx`, `src/sidepanel/App.test.tsx`, `src/ui/components/PageCard.tsx`, and `src/ui/components/SearchResultCard.tsx` — detail-view polish, retry affordance, and filter-chip wiring.
- Modify `src/options/Options.tsx` and `src/options/Options.test.tsx` — export-all-data, delete-all-data, and auto-save presentation.
- Modify `src/popup/Popup.tsx` and `src/popup/Popup.test.tsx` — retry UX for failed saves.
- Modify `src/ui/components/SurfaceShell.tsx` and shared Tailwind styles — dark mode polish.
- Modify `manifest.config.ts` — **add the `"alarms"` permission** (required by Task 2 auto-save), plus any final command/permission cleanup.
- Modify `README.md`, `package.json`, and `src/shared/messages.ts` — release notes, version bump, and `APP_VERSION`.

---

## Task ordering & parallelization

- **Task 1 (stemming)** is fully independent — safe to do first or in parallel.
- **Task 2 and Task 3 both modify `src/worker/index.ts` and `src/shared/messages.ts`.** If dispatched to parallel agents they will conflict; run them **serially** or give both to a single owner.
- **Task 5 (vector threshold) depends on Task 1 landing first** (re-measure only after stemming is in).
- **Task 6 (release) is last** and gates on every other task being green.

---

## Task 1: Stem Latin tokens in BM25

**Files:**

- Modify: `src/lib/bm25.ts`
- Test: `src/lib/bm25.test.ts`

Stem only the Latin/ASCII token path inside the shared tokenizer so query and document tokenization stay identical. Do not touch the CJK bigram path. Keep the implementation dependency-free and small.

**No data migration / re-index needed:** BM25 calls `tokenize()` on documents at **query/scan time** (stems are never persisted), so adding stemming takes effect immediately for existing chunks — unlike embeddings, which require re-indexing. Do not re-index for this change.

- [ ] **Step 1: Add failing stemming tests**

Add coverage that proves the shared tokenizer now normalizes morphology while preserving existing behavior:

```ts
describe("tokenize stemming", () => {
  it("stems reporting and report to the same token", () => {
    expect(tokenize("reporting")).toEqual(tokenize("report"));
  });

  it("stems stakeholder and stakeholders to the same token", () => {
    expect(tokenize("stakeholder")).toEqual(tokenize("stakeholders"));
  });

  it("leaves CJK bigrams unchanged", () => {
    expect(tokenize("报告")).toEqual(["报告"]);
  });

  it("does not mangle short dev tokens", () => {
    expect(tokenize("css")).toContain("css");
    expect(tokenize("json")).toContain("json");
  });
});

describe("bm25 stemming recall", () => {
  it("matches stakeholder against stakeholders", () => {
    expect(bm25Search("stakeholder", ["...engaging stakeholders on scope..."])).toHaveLength(1);
  });

  it("matches reporting against report", () => {
    expect(bm25Search("reporting", ["...a one-pager report ..."])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement stemming in the Latin branch**

Add a tiny English stemmer or equivalent minimal normalization directly in the Latin-token loop. Apply it before `tokens.push(...)` so both the query and corpus path share the exact same normalization.

- [ ] **Step 3: Verify CJK and precision stay intact**

Keep the CJK bigram code byte-for-byte unchanged. Re-run the BM25 test file and the full suite once the new assertions pass.

---

## Task 2: Ship allowlist auto-save (chrome.alarms, NOT setTimeout)

**Files:**

- Modify: `src/worker/services/CaptureService.ts` (or a new `AutoSaveService`)
- Modify: `src/worker/index.ts`
- Modify: `manifest.config.ts` — add the `"alarms"` permission
- Modify: `src/shared/messages.ts`
- Modify: `src/shared/types.ts`
- Test: `src/worker/services/CaptureService.test.ts` (or `AutoSaveService.test.ts`)
- Test: `src/worker/index.test.ts`

**Critical MV3 constraint:** the service worker is terminated after ~30s of
inactivity, and in-memory globals are lost on termination. A
`setTimeout(30_000)` dwell timer will **not** fire reliably — its callback is
dropped when the worker dies. Use **`chrome.alarms`** (which wakes the
possibly-terminated worker when it fires) plus **`chrome.storage.session`** to
persist dwell state across restarts. See [`HANDOFF.md`](../../../HANDOFF.md) and
the Chrome docs (alarms minimum is 30s on Chrome 120+; alarms carry only a
`name`, no payload).

**Design:**

- **Start dwell** — on `chrome.tabs.onActivated` or `onUpdated` (status
  `complete` + allowlisted URL): write `{ url, startedAt }` keyed by tabId into
  `chrome.storage.session`, and `chrome.alarms.create('autosave:<tabId>', { when: Date.now() + 30_000 })`.
- **Cancel dwell** — on switching to another tab, same-tab navigation (URL
  change), or `onRemoved`: `chrome.alarms.clear('autosave:<tabId>')` and remove
  the session entry.
- **On fire** (`chrome.alarms.onAlarm`) — parse the tabId from the alarm name,
  load the session entry, re-query the tab, and **re-verify** it is still active
  and still on the same allowlisted URL; only then run the existing capture
  pipeline with `saveMode: 'auto'` (dedup via `urlHash` upsert — skip pages
  already saved/ready). Clear the state afterward.

**Implementation discipline (from research):**

- Register `chrome.alarms.onAlarm` **and** the tab listeners **synchronously at
  the top level** of the worker. The worker re-runs its top-level script on every
  wake, so listeners must attach before any `await` or they may miss the event.
- The `alarms` minimum granularity is **30s only on Chrome 120+**
  (`when` / `delayInMinutes: 0.5`); below that Chrome warns and floors it. Treat
  dwell as **"≥30s," not exact** — fine for auto-save. Note the Chrome-120
  dependency in a code comment.
- Do **not** use service-worker keepalive hacks (periodic API pings to stay
  alive) — Google discourages them; alarms is the idiomatic fix.
- Wrap `chrome.alarms` + `chrome.storage.session` behind a thin **injectable
  port** so the dwell logic is unit-testable without real Chrome APIs and tests
  never wait a real 30s.

- [ ] **Step 1: Add auto-save tests (via the injected alarm/storage port)**

Cover: happy path (dwell elapses → save), cancel on tab switch, cancel on
same-tab navigation, **re-verify-on-fire rejects a tab that navigated away**,
allowlist gating, and dedup (already-saved page is not re-saved). No real timers.

- [ ] **Step 2: Implement the alarm-driven dwell flow**

Top-level listeners, `storage.session` state, per-tab alarm names, and
re-verification on fire. Add `"alarms"` to `manifest.config.ts` permissions.
Reuse the existing capture pipeline with `saveMode: 'auto'`.

- [ ] **Step 3: Verify failure/retry and lifecycle survival**

Auto-save failures persist as rows retryable later. Confirm the flow survives a
simulated worker restart — dwell state is rebuilt from `chrome.storage.session`,
never from globals.

---

## Task 3: Add export, delete-all, retry, and filter wiring

**Files:**

- Modify: `src/options/Options.tsx`
- Modify: `src/options/Options.test.tsx`
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/App.test.tsx`
- Modify: `src/ui/components/PageCard.tsx`
- Modify: `src/ui/components/SearchResultCard.tsx`
- Modify: `src/popup/Popup.tsx`
- Modify: `src/popup/Popup.test.tsx`
- Modify: `src/worker/repository/PageRepo.ts`
- Modify: `src/worker/repository/ChunkRepo.ts`

Add the last missing product surfaces from the MVP spec:

- Export-all-data as a JSON download from Options.
- Delete-all-data with confirmation from Options.
- Filter chips wired to the current surface instead of decorative-only state.
- Retry for failed saves. **Note: popup retry already exists** (commits `b65b16d`, `0ebc2e7`). Scope here is **extending** that affordance to the side-panel / detail surfaces, not rebuilding it — check current behavior first to avoid duplicate work.
- Detail view polish that shows the failure state and makes retry/delete actions obvious (polish the existing expandable `PageCard`).

- [ ] **Step 1: Add the failing UI and repository tests**

Cover export payload shape, delete-all confirmation, filter interaction, and retry CTA visibility.

- [ ] **Step 2: Wire the worker messages**

Add typed request/response contracts for export and delete-all, then route them through the worker to the repositories.

- [ ] **Step 3: Implement the UI actions**

Keep the export flow download-only, make delete-all destructive with confirmation, and ensure filter chips actually change the rendered set.

---

## Task 4: Finish dark mode and page-detail polish

**Files:**

- Modify: `src/ui/components/SurfaceShell.tsx`
- Modify: `src/popup/Popup.tsx`
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/options/Options.tsx`
- Modify: `src/ui/components/PageCard.tsx`

Bring the visible surfaces up to release quality: dark-mode colors, spacing, loading/empty states, detail-view copy, and the final “ship-ready” polish pass.

- [ ] **Step 1: Add behavior-level tests (not pixel regression)**

jsdom does not render pixels, so true visual regression is out of reach here.
Instead assert **behavior**: theme class toggling (e.g. the `dark` class applied
to the root), conditional rendering of detail-view fields (summary/chips/
timestamps), and retry/delete affordance visibility per status. Final visual/
contrast polish is verified by **manual QA in both themes** — state that
explicitly rather than implying automated visual coverage.

- [ ] **Step 2: Apply the dark-mode pass**

Make sure the cards, shells, overlays, and buttons read clearly in both themes.

- [ ] **Step 3: Tighten detail view copy and affordances**

Ensure the page detail view exposes summary, chips, timestamps, retry, and delete actions cleanly.

---

## Task 5: Re-check vector threshold only if warranted

**Files:**

- Modify: `src/worker/services/RetrievalService.ts` if needed
- Test / measure: `src/lib/vectorThreshold.measure.test.ts`

Stemming is the required fix. Only after that lands, re-evaluate whether `MIN_VECTOR_SCORE` should move from `0.4` toward `0.3` based on the measurement harness. Treat this as a narrow quality tweak, not a substitute for stemming.

- [ ] **Step 1: Measure against the live embedding model**

Run the harness on the representative query/chunk pairs from the handoff.

- [ ] **Step 2: Lower the threshold only if the data supports it**

Keep the change conservative and document why it is safe.

---

## Task 6: Release M6 and tag v1.0

**Files:**

- Modify: `README.md`
- Modify: `package.json`
- Modify: `src/shared/messages.ts`

Finish with the release packaging: update the version, add the README install/run section and demo GIF, then tag the release as `v1.0`.

- [ ] **Step 1: Update release metadata**

Bump the 4-part version everywhere it is mirrored.

- [ ] **Step 2: Refresh README content**

Document setup, usage, and the 60-second demo GIF path.

- [ ] **Step 3: Verify v1.0 success criteria before tagging**

Gate the release on the parent spec's §3 criteria — in particular **#7: ≥80%
unit-test coverage on `src/lib/**` and `src/worker/services/**`** (run the
coverage report and confirm), plus #2 (auto-save works end-to-end) and #6
(README + demo GIF present). Do not tag until these pass.

- [ ] **Step 4: Tag the release**

Create the final `v1.0` tag once the branch is green and the criteria above hold.
