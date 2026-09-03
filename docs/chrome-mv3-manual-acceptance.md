# Chrome MV3 manual acceptance checklist

Run this checklist before the v0.1.0 release. Record failures in the release issue before merging or tagging.

## Setup

- [x] Run `pnpm build`.
- [x] Load `dist/` as an unpacked extension in `chrome://extensions`.
- [x] Pin DevRecall and open both the side panel and Options.
- [x] Have a valid OpenAI API key available.
- [x] Use DevTools Network or an equivalent request log to count OpenAI requests.

## Worker restart during enrichment

1. Select **Local-only** and save a readable page.
2. Start `Add AI features` for that page (explicit consent works in any mode).
3. While the page shows `Adding AI features...`, stop the extension service worker from `chrome://extensions`.
4. Reopen the side panel.

- [x] The page returns to `Saved locally` after worker startup recovery.
- [x] DevRecall does not replay the interrupted OpenAI request.
- [x] The page offers `Add AI features` for a newly confirmed attempt.

## Local-only during a confirmed batch

1. Save at least three pages that remain `keyword_ready`.
2. In Options, select `Add AI features to local pages`.
3. Verify the confirmation count, then confirm.
4. While the first request is in flight, switch to Local-only.

- [x] The request already sent may finish.
- [x] No later tagging, embedding, or retry request is sent.
- [x] Unsent pages remain `keyword_ready` without an enrichment error.
- [x] Progress reports the operation as canceled, not failed.

## Semantic re-index while Local-only is selected

Re-index candidates are `ready` pages, never `keyword_ready`. Make at least
three eligible first: raise `SEMANTIC_INDEX_VERSION` by one in
`src/worker/services/CaptureService.ts`, run `pnpm build`, and reload the
unpacked extension so your enriched pages become candidates.

1. In Options, select `Re-index semantic search`.
2. Verify the confirmation counts `ready` pages only, then confirm.
3. While the first embedding request is in flight, switch to Local-only.

- [x] The embedding request already sent may finish.
- [x] No further embedding request is sent.
- [x] Unsent pages stay `ready`; their chunks, embeddings, and metadata do not change.
- [x] Progress reports the operation as canceled, not failed.

## Semantic re-index with the Cancel button

1. Repeat the setup above so at least three `ready` pages are eligible again.
2. In Options, select `Re-index semantic search`, verify the count, then confirm.
3. Click `Cancel` while the first embedding request is in flight.

- [x] The embedding request already sent may finish.
- [x] No further embedding request is sent.
- [x] Unsent pages stay `ready`; their chunks, embeddings, and metadata do not change.
- [x] Progress reports the operation as canceled, not failed.

## Auto-save in both effective modes

1. Enable auto-save.
2. In Hybrid with a valid key, stay on an allowlisted page for at least 30 seconds.

- [x] The page saves locally before enrichment starts.
- [x] The page can progress from `keyword_ready` to `ready`.

3. Switch to Local-only and visit a different allowlisted page for at least 30 seconds.

- [x] The page stops at `keyword_ready`.
- [x] No OpenAI request is sent.

4. Visit a non-allowlisted page in both modes.

- [x] Auto-save does not capture the page.

## Remove and restore an API key

1. Store Hybrid as the preference and enrich at least one page.
2. Remove the API key and accept the confirmation.

- [x] Effective mode becomes Local-only while the stored Hybrid preference remains.
- [x] Saved pages, summaries, tags, classifications, and embeddings remain available.
- [x] Automatic capture and search send no OpenAI requests.
- [x] Per-page AI actions remain visible but disabled with a Settings link.

3. Add a valid key again.

- [x] Effective mode returns to Hybrid without rewriting the stored preference.
- [x] Existing page data remains unchanged.

## Search mode and fallback display

1. Search in Local-only.

- [x] Results use BM25 and the completed search reports `Local-only`.
- [x] Results may include `keyword_ready`, `enriching`, and `ready` pages.

2. Search in Hybrid with a valid key.

- [x] The completed search reports `Hybrid`.
- [x] OpenAI receives one query-embedding request unless a cached result is used.

3. Make the embedding request fail, then search again.

- [x] BM25 results remain visible.
- [x] The UI says `Semantic search unavailable. Showing keyword results.`

4. Restore the key or network and run a different query.

- [x] The completed search reports `Hybrid` again.

## Completion

- [x] Every check above passes in the production build.
- [x] The observed OpenAI request counts match the privacy descriptions in README.
- [x] Any deviation has a linked blocking issue.
