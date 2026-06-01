# DevRecall M6 — Handoff (Tasks 3 & 4 complete)

**Date:** 2026-06-01
**Worktree:** `.claude/worktrees/M6-polish-auto-save-ship`
**Branch:** `worktree-M6-polish-auto-save-ship`
**Version:** `0.5.4.7`

---

## TL;DR — where we are

M6 is executing task-by-task via the subagent-driven-development skill. **Tasks 1–4 are
done.** Tasks 3 and 4 were implemented together in the working tree and committed as a
single combined "M6 polish" commit (per an explicit decision to combine them, since the
two tasks share files and were physically intertwined). Remaining: Task 5 (vector
threshold re-check, needs an API key) and Task 6 (release v1.0).

---

## Task status

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | BM25 English stemming | ✅ committed | Porter stemmer, Latin token path only |
| 2 | Allowlist auto-save (chrome.alarms) | ✅ committed | `AutoSaveService`, restart-safe via `storage.session` |
| 3 | Export / delete-all / filter / retry | ✅ committed | Combined M6 commit — see below |
| 4 | Dark mode & detail polish | ✅ committed | Combined M6 commit — see below |
| 5 | Vector threshold re-check | 🔲 pending | Needs `OPENAI_API_KEY` to measure |
| 6 | Release v1.0 | 🔲 pending | Gates on coverage + auto-save E2E + README/GIF |

---

## What Tasks 3 & 4 delivered (combined commit)

**Task 3 — surfaces:**
- Export-all-data as a JSON download from Options (payload includes `schemaVersion`).
- Delete-all-data with confirmation from Options; `PageRepo.deleteAll()` clears `pages`
  + `chunks` in one Dexie transaction (same atomic guarantee as single-page delete).
- Filter chips in the side panel actually filter **both** the page list and the search
  hits; `aria-pressed` reflects `activeFilter`.
- Retry for failed saves extended to the side panel via the expandable `PageCard`
  (`page.retry` worker route re-runs `processPage` in place — no duplicate record).
- Detail view shows the failure state: failed badge, Retry button, and (new) the
  `errorReason` text surfaced in the expanded failed card.

**Task 4 — polish:**
- Media-based dark mode (`darkMode: "media"`) across popup, side panel, options, cards,
  empty/loading states, `SurfaceShell`, `PageCard`, and `SearchResultCard`. Surfaces use
  semantic CSS-variable tokens (`bg-surface`/`text-foreground`/`border-default`/
  `bg-surface-raised`) plus explicit `dark:` variants on hard-coded status colors. A scan
  found zero light-only leftovers.
- Detail view exposes summary, topics/technologies chips, timestamps, retry, delete.
- **Behavior-level tests** (jsdom can't assert pixels/contrast under media mode):
  `dark:`-variant presence on status-colored elements, detail-view conditional rendering
  (collapsed vs expanded, both states), and affordance visibility per status. **Visual
  contrast must be verified by manual QA in both themes** — there is no automated visual
  coverage.

**Review:** spec compliance + Opus code-quality review done (APPROVE WITH MINOR ISSUES;
all minors fixed: side-panel `errorReason`, repo-level `deleteAll`/`exportAll` tests,
retry guard tests, Options export/delete error handling).

---

## Build & test (current state)

```bash
pnpm test        # 260/260 pass (23 files)
pnpm typecheck   # clean
pnpm lint        # clean
pnpm build       # clean (pre-existing chunk-size warning only)
```

> Note: integration/measurement tests that call OpenAI are skipped unless
> `OPENAI_API_KEY` is set (CI-safe).

---

## Remaining work

### Task 5: Vector threshold re-check (needs API key)

Stemming (Task 1) has landed, so re-measure now. Run the harness:
```bash
OPENAI_API_KEY=sk-... pnpm test src/lib/vectorThreshold.measure.test.ts
```
Lower `MIN_VECTOR_SCORE` in `src/worker/services/RetrievalService.ts` from `0.4` → `0.3`
**only if** the data supports it. Conservative, documented change — not a substitute for
stemming. If no API key is available, this task is blocked on the human providing one.

### Task 6: Release v1.0

- Final version bump to `1.0.0.0` (`package.json` + `APP_VERSION` in
  `src/shared/messages.ts`).
- README install/run section + 60-second demo GIF path.
- Verify v1.0 success criteria before tagging (parent spec §3): **#7 ≥80% unit-test
  coverage on `src/lib/**` and `src/worker/services/**`** (`pnpm test --coverage`),
  #2 auto-save works end-to-end, #6 README + demo GIF present.
- Create `git tag v1.0` once the branch is green and criteria hold. **(Outward-facing —
  confirm with the human before tagging.)**

---

## Key references

| File | Relevance |
|------|-----------|
| `docs/superpowers/plans/2026-05-31-m6-polish-auto-save-ship.md` | Full task specs |
| `src/worker/index.ts` | Typed RPC dispatch incl. `page.retry`/`data.export`/`data.deleteAll` |
| `src/worker/repository/PageRepo.ts` | `exportAll()`, `deleteAll()`, `getById()`, `updatePage()` |
| `src/sidepanel/App.tsx` | Filter wiring + retry wiring |
| `src/ui/components/PageCard.tsx` | Expandable detail view, retry/delete affordances, errorReason |
| `src/worker/services/RetrievalService.ts` | `MIN_VECTOR_SCORE` (Task 5) |

To resume: do Task 5 (if an API key is available) then Task 6, following the M6 plan.
