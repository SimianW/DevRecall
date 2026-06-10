# Handoff — Pre-v1.0 Refactor + UX (Tasks 1–3 of 10 complete)

**Date:** 2026-06-10
**Worktree:** `.claude/worktrees/M6-polish-auto-save-ship`
**Branch:** `worktree-M6-polish-auto-save-ship`
**HEAD:** `7bb53a0` · **Version:** `0.5.7.2`

---

## TL;DR

Executing `docs/superpowers/plans/2026-06-10-pre-v1-refactor-ux.md` via the
**subagent-driven-development** skill (fresh implementer subagent per task, then a
spec-compliance review, then a code-quality review — both must approve before the
next task). Tasks 1–3 are committed and double-approved. **Task 4 is next** (its
implementer was about to be dispatched when the human paused the run).

Spec: `docs/superpowers/specs/2026-06-10-pre-v1-refactor-ux-design.md` (user-approved).

## Model routing (user's instruction, mid-run update)

- **All implementer subagents: sonnet.**
- **Reviews: opus for hard ones, sonnet for easy ones.**
  (Hard ≈ multi-file/architectural/privacy-sensitive: Tasks 2, 3, 6, and the final
  review. Easy ≈ mechanical/UI-local: Tasks 4, 5, 7, 8, 9.)
- Tasks 1–2 implementers ran before the update (T1 sonnet, T2 opus); all reviews so
  far ran on opus.

## Task status

| # | Task | Status | Commit |
|---|------|--------|--------|
| 1 | Shared RPC client `src/ui/rpc.ts` + collapse App/Options defaults | ✅ done, both reviews approved | `f374169` (0.5.7.0) |
| 2 | Worker split: `handlers.ts` + thin `index.ts` + `processPageInBackground` | ✅ done, both reviews approved | `abf8e6b` (0.5.7.1) |
| 3 | Auto-save flag: `shared/allowlist.ts`, `AutoSaveSettingStore`, messages, handler cases, `startDwell` gate (off by default) | ✅ done, both reviews approved | `7bb53a0` (0.5.7.2) |
| 4 | Options auto-save toggle + allowlist display | 🔶 NEXT — not started | target 0.5.7.3 |
| 5 | Remove popup; `setPanelBehavior({ openPanelOnActionClick: true })` | ⬜ | target 0.5.7.4 |
| 6 | SaveBar in side panel (save + live status, tab tracking) | ⬜ | target 0.5.7.5 |
| 7 | Filter labels: All / Docs / Stack Overflow / GitHub | ⬜ | target 0.5.7.6 |
| 8 | Warm Editorial restyle (CSS variables, terracotta accent, serif titles, pill filters) | ⬜ | target 0.5.7.7 |
| 9 | Housekeeping: move root `HANDOFF.md` (main repo) → docs, rewrite CLAUDE.md | ⬜ | docs only |
| 10 | Final verification + final whole-implementation code review | ⬜ | — |

Test/quality state at HEAD: **290 passed, 1 skipped; typecheck, lint clean.**

## How to resume

1. Re-invoke `superpowers:subagent-driven-development`.
2. Dispatch the Task 4 implementer (sonnet) with the FULL task text from the plan
   (`### Task 4` section) plus this context: Options uses DI props with `default*`
   fallbacks; Task 3 already provides `settings.getAutoSave`/`settings.setAutoSave`
   messages and `ALLOWLIST_DISPLAY` in `src/shared/allowlist.ts`; `sendRequest`
   comes from `src/ui/rpc.ts`. Implementer must read `Options.tsx` +
   `Options.test.tsx` and follow existing test patterns. TDD; version 0.5.7.3 in
   `package.json` AND `APP_VERSION`.
3. After DONE: spec review (sonnet), then quality review (sonnet), fix loops until
   both approve, mark complete, continue with Task 5.
4. After Task 10: final code-reviewer subagent over `f6703d6..HEAD`, then
   `superpowers:finishing-a-development-branch`.

## Review findings worth carrying forward (non-blocking minors, all deferred)

- T1: `sendRequest`'s silent `catch {}` could `console.debug` for field debugging.
- T3: `AutoSaveService` re-exports allowlist symbols solely for its test — could
  point the test at `shared/allowlist` instead; `AutoSaveEnabledPort` lacks a doc
  comment; index.ts wraps the store in a redundant arrow (defensible for symmetry).
- T3 reviewer suggestion: tiny test asserting `ALLOWLIST_DISPLAY.length ===
  ALLOWLIST_PATTERNS.length` to catch drift (out of scope; nice for Task 10 or v1.1).

## Gotchas discovered this run

- **Reviewer subagents may detach HEAD** (one checked out the review commit). After
  each review, verify `git status` shows the branch; if detached at the branch tip,
  `git checkout worktree-M6-polish-auto-save-ship`. Tell review subagents to work
  read-only (later prompts already include this).
- **This branch's CLAUDE.md is the stale M1-era version** (the M5/M6 rewrite
  `b7612c6` lives only on `dev`). Task 9 rewrites CLAUDE.md per the plan — when it
  does, base the edits on what's actually in this worktree, and reconcile with
  dev's version at merge time.
- The worktree has untracked `Todo.md` and `.superpowers/` (visual-companion mockups
  from brainstorming). Leave them; consider adding `.superpowers/` to `.gitignore`.
- Existing `HANDOFF.md` at the MAIN repo root (`/Users/simianwang/Developer/projects/DevRecall/HANDOFF.md`,
  untracked, M6 Tasks 1–5 era) is the file Task 9's "move HANDOFF.md" step refers to —
  but note it is untracked in the main checkout, not this worktree; `git mv` won't
  apply. Just `mkdir -p docs/superpowers/handoffs` and write/commit the content here.

## Design decisions locked during brainstorming (already in the spec)

- Popup removed; icon opens side panel; save moves into a SaveBar in the panel.
- Auto-save **off by default** (privacy/opt-in).
- Visual direction: **Warm Editorial** light (warm paper, terracotta `#9a3412`,
  serif titles) + **Warm Charcoal** dark (`#1c1917`/`#262220`/`#33302c`, accent
  `#c2562c`). Mockups in `.superpowers/brainstorm/17827-1781121342/content/`.
- Deferred to v1.1: editable allowlist, saved-date on cards, no-API-key search hint.

## After this plan finishes

The M6 plan's Task 6 ship steps still apply: demo GIF, manual E2E (auto-save +
dark mode QA), version → `1.0.0.0`, tag `v1.0` (tag only with explicit human
confirmation).
