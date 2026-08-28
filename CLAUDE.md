# CLAUDE.md

DevRecall is a local-first Chrome extension that captures technical pages and retrieves
them with BM25 keyword search or optional Hybrid search. Hybrid combines BM25 and
embeddings with Reciprocal Rank Fusion. Saving and keyword search need no API key.
OpenAI runs only on explicit user action or automatic enrichment while the effective
mode is `hybrid`.

Stack: React 18, TypeScript 6, Vite, Vitest, Dexie, Chrome MV3, Tailwind CSS.

## Workflow

This repo uses the `mattpocock/skills` workflow. Route work through its skills:

- New feature or design: start with `/grill-with-docs`, which records decisions in the
  domain docs.
- Work that fits one session: use `/implement`. Multi-session work: use `/to-spec`, then
  `/to-tickets`, then `/implement` one ticket at a time.
- `/implement` owns testing, `/code-review`, and the final commit.
- Bugs and performance regressions: use `/diagnosing-bugs`. Open questions: use
  `/research`. Vague ideas: use `/grill-me`.
- Active specs and tickets live in GitHub Issues. Historical specs are under
  `docs/specs/`; historical plans are under `docs/plans/`.
- Issue tracker conventions: `docs/agents/issue-tracker.md`.
- Triage labels: `docs/agents/triage-labels.md`.
- Domain-doc routing: `docs/agents/domain.md`.

## Non-negotiable rules

1. **Version bump on every code change.** `package.json` `version` and `APP_VERSION`
   in `src/shared/messages.ts` must match exactly as four-part `X.Y.Z.N`.
2. **MV3 stops the worker after about 30 seconds of inactivity; in-memory globals are
   lost.** For delayed worker work that must survive suspension, use `chrome.alarms`
   with `chrome.storage.session` and register `onAlarm` at module scope.
   `AutoSaveService` is the reference pattern. Short UI debounces and in-flight retry
   backoff may use timers.
3. **Local-only never sends page content or queries to OpenAI automatically**, even
   when a key is present. Explicit "Add AI features" and confirmed bulk operations are
   direct consent and may send content.
4. **Stored mode is not effective mode** (`src/shared/modes.ts`). A missing key forces
   effective `local` without overwriting the stored preference. `keyword_fallback`
   describes one completed search and is never stored. If Hybrid query embedding fails,
   return BM25 results flagged `keyword_fallback`.
5. **Capture commits locally before any paid work.** One Dexie transaction reaches
   `keyword_ready` with word chunks before optional enrichment claims it atomically.
   `failed` is reserved for local save failures. Startup resets stale `enriching`
   records to `keyword_ready` without replaying requests.
6. **Paid bulk operations are confirmed, sequential, and cancellable between pages.**
   `BulkTaskRunner` keeps its queue in memory, so an MV3 restart never replays charges.
7. **Tests that make real OpenAI requests skip unless `OPENAI_API_KEY` is set.** This
   keeps CI green.

Auto-save stays opt-in and off. The allowlist lives in `src/shared/allowlist.ts`.

## Where to look

- Message and RPC contract: `src/shared/messages.ts`. Edit types there; do not duplicate
  the contract in docs.
- Dispatcher flow: `src/worker/handlers.ts`. Composition and listeners:
  `src/worker/index.ts`.
- Current capture behavior: `src/worker/services/CaptureService.ts` and
  `src/worker/repository/PageRepo.ts`.
- Current retrieval behavior: `src/worker/services/RetrievalService.ts`.
- Historical architecture and design rationale:
  `docs/specs/2026-05-16-devrecall-mvp-design.md`. It predates the keyword-first
  pipeline. Verify current behavior in code and tests before restructuring capture or
  retrieval.
