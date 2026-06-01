# DevRecall M6 — Handoff (Tasks 1–5 complete)

**Date:** 2026-06-01
**Worktree:** `.claude/worktrees/M6-polish-auto-save-ship`
**Branch:** `worktree-M6-polish-auto-save-ship`
**Version:** `0.5.4.8`

---

## TL;DR — where we are

M6 is executing task-by-task via the subagent-driven-development skill. **Tasks 1–5 are
done.** Tasks 3 and 4 were implemented together in the working tree and committed as a
single combined "M6 polish" commit (per an explicit decision to combine them, since the
two tasks share files and were physically intertwined). Task 5 (vector threshold re-check)
is now complete — see section below. Remaining: Task 6 (release v1.0).

---

## Task status

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | BM25 English stemming | ✅ committed | Porter stemmer, Latin token path only |
| 2 | Allowlist auto-save (chrome.alarms) | ✅ committed | `AutoSaveService`, restart-safe via `storage.session` |
| 3 | Export / delete-all / filter / retry | ✅ committed | Combined M6 commit — see below |
| 4 | Dark mode & detail polish | ✅ committed | Combined M6 commit — see below |
| 5 | Vector threshold re-check | ✅ done | Re-measured post-stemming; kept 0.4 |
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

### Task 5: Vector threshold re-check — DONE

Re-measured post-stemming against the live `text-embedding-3-small` model. Result table:

| query | target | best |
|-------|--------|------|
| little | 0.129 | 0.131* |
| small | 0.155 | 0.158* |
| tiny fraction of users | 0.267 | 0.267 |
| reporting | 0.275 | 0.275 |
| report | 0.223 | 0.223 |
| hyperlinks | 0.384 | 0.384 |
| one-pager | 0.506 | 0.596* |

`(* = top-scoring chunk is NOT the intended target → false-positive risk)`

**Decision: KEEP `MIN_VECTOR_SCORE` at 0.4.** Rationale:
- The only probe in [0.30, 0.40) with a clean target match is `hyperlinks` (0.384), an
  exact but peripheral keyword already recalled by the BM25 arm — admitting it via vector
  is neutral, not a recall gain.
- Genuine paraphrases (`tiny fraction of users` 0.267, `reporting` 0.275) sit below 0.3,
  so lowering to 0.3 would not recover them; recovering them needs ~0.26, too permissive
  for precision on a real corpus.
- `reporting` is now recalled by the keyword arm anyway via Task 1 stemming
  (`reporting`→`report`).
- 0.4 remains the correct high-confidence conceptual gate; 0.3 adds false-positive risk
  with no real recall benefit.

The measurement harness is committed at `src/lib/vectorThreshold.measure.test.ts`. It
skips unless `OPENAI_API_KEY` is set (CI-safe). To re-run:
```bash
OPENAI_API_KEY=sk-... pnpm test src/lib/vectorThreshold.measure.test.ts
```

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

To resume: do Task 6 (release v1.0), following the M6 plan.
