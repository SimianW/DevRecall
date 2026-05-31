# M4 Keyword Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build M4 so that capturing a page also splits its text into chunks, and the side panel search box runs a BM25-lite keyword search over those chunks. Results render the best-matching chunk per page with the query terms highlighted.

**Architecture:** M4 adds the first retrieval path. On capture, `CaptureService` chunks `fullText` with a simple word-window splitter and persists the chunks through a new `ChunkRepo` (new `chunks` table, Dexie schema bumped to version 2). Chunking is independent of the LLM, so keyword search works even with no API key. A new `RetrievalService` loads all chunks, scores them with a pure BM25-lite function, keeps the best chunk per page, joins page metadata, and builds highlighted HTML. The side panel sends `search.run` and renders `PageHit[]`. No embeddings, no vector search, no RRF fusion, no auto-save — those are M5/M6.

**Tech Stack:** TypeScript strict mode, React 18, Vite, CRXJS MV3, Dexie, Vitest, Testing Library.

---

## Scope

M4 implements keyword retrieval only:

- `lib/chunking.ts` — pure, simple word-window chunking (no tokenizer; M5 replaces this with token-based chunking).
- `lib/bm25.ts` — pure BM25-lite scorer over an array of document strings; computes IDF, term frequency, and average document length internally.
- `lib/highlight.ts` — pure HTML-escaping highlighter that wraps matched terms in `<mark>`.
- `chunks` table + `ChunkRepo` — transactional per-page chunk replacement and a full-corpus read.
- `CaptureService.save` also writes chunks for the saved page.
- `RetrievalService.search` — BM25 over all chunk texts, best chunk per page, page metadata join, highlighted HTML.
- Worker handles `search.run` → `search.results`.
- Side panel search box is wired: debounced query, result list, highlighted chunk, "keyword" match badge, loading and empty states.

Out of scope (M5/M6):

- Embeddings, vector search, RRF fusion, the "matched by meaning" badge.
- Token-based chunking with `js-tiktoken`.
- A persisted `corpusStats` table — M4 derives `avgdl` from the in-memory corpus the full scan already loads (see Self-Review Notes).
- An in-memory chunk cache refreshed on broadcast; M4 reads chunks from IndexedDB per query.
- `sourceType` filter chips wired to search (they remain visual, as today).
- Auto-save, page detail slide-over, export.

Baseline before plan creation (run these to confirm green):

```bash
pnpm install
pnpm test
pnpm typecheck
```

Expected: all pass. The repository is at M3 (capture + LLM tagging + options API key + status polling).

## File Structure

- Modify `src/shared/types.ts` — add `ChunkRecord`, `SearchMatchReason`, `PageHit`.
- Modify `src/shared/messages.ts` — add `search.run` request and `search.results` response.
- Create `src/lib/chunking.ts` and `src/lib/chunking.test.ts`.
- Create `src/lib/bm25.ts` and `src/lib/bm25.test.ts`.
- Create `src/lib/highlight.ts` and `src/lib/highlight.test.ts`.
- Modify `src/worker/repository/db.ts` — add `chunks` table at schema version 2.
- Create `src/worker/repository/ChunkRepo.ts` and `src/worker/repository/ChunkRepo.test.ts`.
- Modify `src/worker/services/CaptureService.ts` and `src/worker/services/CaptureService.test.ts` — write chunks on save.
- Create `src/worker/services/RetrievalService.ts` and `src/worker/services/RetrievalService.test.ts`.
- Modify `src/worker/index.ts` and `src/worker/index.test.ts` — wire `search.run` and `RetrievalService`.
- Create `src/ui/components/SearchResultCard.tsx`; modify `src/ui/components/index.ts`.
- Modify `src/sidepanel/App.tsx` and `src/sidepanel/App.test.tsx` — wire the search box.

## Task 1: Extend Shared Types And Message Contract

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Add chunk and search-result types**

Append to `src/shared/types.ts` after the `TaggingResult` type:

```ts
export type ChunkRecord = {
  id: string; // ULID
  pageId: string; // FK → PageRecord.id
  ordinal: number; // 0-based position within the page
  text: string; // simple word-window chunk; re-chunked in M5
  schemaVersion: 1;
};

export type SearchMatchReason = "keyword"; // M5 adds "vector" | "both"

export type PageHit = {
  page: PageListItem;
  bestChunk: {
    text: string;
    ordinal: number;
    highlightedHtml: string; // matched terms wrapped in <mark>, HTML-escaped
  };
  score: number;
  matchReason: SearchMatchReason;
};
```

- [ ] **Step 2: Add the search message pair**

In `src/shared/messages.ts`, update the imports on line 1 to include `PageHit`:

```ts
import type { ExtractedPage, PageHit, PageListItem, PageStatus } from "./types";
```

Add the `search.run` request to the `DevRecallRequest` union (after the `page.statusForUrl` line):

```ts
  | { type: "page.statusForUrl"; payload: { url: string } }
  | { type: "search.run"; payload: { query: string; topK?: number } };
```

Add the `search.results` response to the `DevRecallResponse` union (immediately before the `error` member):

```ts
  | {
      type: "search.results";
      payload: {
        hits: PageHit[];
      };
    }
  | {
      type: "error";
      payload: {
        message: string;
      };
    };
```

- [ ] **Step 3: Verify types compile**

```bash
pnpm typecheck
```

Expected: PASS. No code uses the new types yet.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/messages.ts
git commit -m "feat: add m4 chunk and search message contract"
```

## Task 2: Add Simple Chunking

**Files:**
- Create: `src/lib/chunking.test.ts`
- Create: `src/lib/chunking.ts`

- [ ] **Step 1: Write failing chunking tests**

Create `src/lib/chunking.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { chunkText } from "./chunking";

describe("chunkText", () => {
  it("returns a single chunk when the text is shorter than the window", () => {
    expect(chunkText("alpha beta gamma")).toEqual(["alpha beta gamma"]);
  });

  it("returns an empty array for blank text", () => {
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("splits long text into overlapping windows", () => {
    const words = Array.from({ length: 5 }, (_, i) => `w${i}`).join(" ");

    const chunks = chunkText(words, { maxWords: 2, overlapWords: 1 });

    expect(chunks).toEqual(["w0 w1", "w1 w2", "w2 w3", "w3 w4"]);
  });

  it("collapses runs of whitespace into single spaces", () => {
    expect(chunkText("alpha   beta\n\ngamma")).toEqual(["alpha beta gamma"]);
  });

  it("rejects an overlap that is not smaller than the window", () => {
    expect(() => chunkText("a b c", { maxWords: 2, overlapWords: 2 })).toThrow(
      "overlapWords must be between 0 and maxWords",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/lib/chunking.test.ts
```

Expected: FAIL with `Failed to resolve import "./chunking"`.

- [ ] **Step 3: Add chunking implementation**

Create `src/lib/chunking.ts`:

```ts
export type ChunkOptions = {
  maxWords?: number;
  overlapWords?: number;
};

const DEFAULT_MAX_WORDS = 180;
const DEFAULT_OVERLAP_WORDS = 30;

/**
 * Splits text into overlapping word windows. Deliberately simple for M4 —
 * M5 replaces this with token-based chunking via js-tiktoken.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  const overlapWords = options.overlapWords ?? DEFAULT_OVERLAP_WORDS;

  if (maxWords <= 0) {
    throw new Error("maxWords must be greater than 0");
  }

  if (overlapWords < 0 || overlapWords >= maxWords) {
    throw new Error("overlapWords must be between 0 and maxWords");
  }

  const words = text.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  const step = maxWords - overlapWords;
  const chunks: string[] = [];

  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + maxWords).join(" "));

    if (start + maxWords >= words.length) {
      break;
    }
  }

  return chunks;
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm test src/lib/chunking.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/chunking.ts src/lib/chunking.test.ts
git commit -m "feat: add simple word-window chunking"
```

## Task 3: Add BM25-lite Scorer

**Files:**
- Create: `src/lib/bm25.test.ts`
- Create: `src/lib/bm25.ts`

- [ ] **Step 1: Write failing BM25 tests**

Create `src/lib/bm25.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { bm25Search, tokenize } from "./bm25";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, and drops stopwords", () => {
    expect(tokenize("The Horizontal-Pod Autoscaler scales PODS!")).toEqual([
      "horizontal",
      "pod",
      "autoscaler",
      "scales",
      "pods",
    ]);
  });
});

describe("bm25Search", () => {
  const documents = [
    "horizontal pod autoscaler automatically scales pods",
    "react hydration mismatch during server side rendering",
    "general notes about deployments and services",
  ];

  it("returns an empty array for a blank query", () => {
    expect(bm25Search("   ", documents)).toEqual([]);
  });

  it("returns an empty array when there are no documents", () => {
    expect(bm25Search("pods", [])).toEqual([]);
  });

  it("ranks the matching document first and reports matched terms", () => {
    const hits = bm25Search("autoscale pods", documents);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].index).toBe(0);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].matchedTerms).toContain("pods");
  });

  it("excludes documents that contain no query term", () => {
    const hits = bm25Search("hydration", documents);

    expect(hits.map((hit) => hit.index)).toEqual([1]);
  });

  it("honors the topK option", () => {
    const hits = bm25Search("pods deployments services", documents, { topK: 1 });

    expect(hits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/lib/bm25.test.ts
```

Expected: FAIL with `Failed to resolve import "./bm25"`.

- [ ] **Step 3: Add BM25 implementation**

Create `src/lib/bm25.ts`:

```ts
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he",
  "in", "is", "it", "its", "of", "on", "that", "the", "to", "was", "were",
  "will", "with",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

export type Bm25Options = {
  k1?: number;
  b?: number;
  topK?: number;
};

export type Bm25Hit = {
  index: number;
  score: number;
  matchedTerms: string[];
};

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;
const DEFAULT_TOP_K = 50;

/**
 * BM25-lite over an array of document strings. Average document length is
 * derived from the provided corpus, so callers pass the full chunk set.
 */
export function bm25Search(
  query: string,
  documents: string[],
  options: Bm25Options = {},
): Bm25Hit[] {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
  const topK = options.topK ?? DEFAULT_TOP_K;

  const queryTerms = Array.from(new Set(tokenize(query)));

  if (queryTerms.length === 0 || documents.length === 0) {
    return [];
  }

  const termCounts = documents.map((doc) => {
    const counts = new Map<string, number>();
    for (const token of tokenize(doc)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
  });

  const docLengths = termCounts.map((counts) =>
    Array.from(counts.values()).reduce((sum, count) => sum + count, 0),
  );
  const totalLength = docLengths.reduce((sum, length) => sum + length, 0);
  const avgdl = totalLength / documents.length || 1;

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    let frequency = 0;
    for (const counts of termCounts) {
      if (counts.has(term)) {
        frequency += 1;
      }
    }
    documentFrequency.set(term, frequency);
  }

  const corpusSize = documents.length;
  const hits: Bm25Hit[] = [];

  for (let index = 0; index < corpusSize; index += 1) {
    const counts = termCounts[index];
    const length = docLengths[index];
    let score = 0;
    const matchedTerms: string[] = [];

    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) {
        continue;
      }

      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5));
      const denominator = tf + k1 * (1 - b + (b * length) / avgdl);

      score += idf * ((tf * (k1 + 1)) / denominator);
      matchedTerms.push(term);
    }

    if (score > 0) {
      hits.push({ index, score, matchedTerms });
    }
  }

  hits.sort((left, right) => right.score - left.score);

  return hits.slice(0, topK);
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm test src/lib/bm25.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bm25.ts src/lib/bm25.test.ts
git commit -m "feat: add bm25-lite keyword scorer"
```

## Task 4: Add Keyword Highlighter

**Files:**
- Create: `src/lib/highlight.test.ts`
- Create: `src/lib/highlight.ts`

- [ ] **Step 1: Write failing highlighter tests**

Create `src/lib/highlight.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { highlightTerms } from "./highlight";

describe("highlightTerms", () => {
  it("wraps whole-word matches in <mark>, case-insensitively", () => {
    expect(highlightTerms("Auto scaling pods", ["auto", "pods"])).toBe(
      "<mark>Auto</mark> scaling <mark>pods</mark>",
    );
  });

  it("escapes HTML before inserting marks", () => {
    expect(highlightTerms("<script>pods</script>", ["pods"])).toBe(
      "&lt;script&gt;<mark>pods</mark>&lt;/script&gt;",
    );
  });

  it("returns escaped text unchanged when there are no terms", () => {
    expect(highlightTerms("a & b", [])).toBe("a &amp; b");
  });

  it("does not highlight partial-word matches", () => {
    expect(highlightTerms("autoscaler", ["auto"])).toBe("autoscaler");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/lib/highlight.test.ts
```

Expected: FAIL with `Failed to resolve import "./highlight"`.

- [ ] **Step 3: Add highlighter implementation**

Create `src/lib/highlight.ts`:

```ts
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes the text, then wraps whole-word occurrences of the given terms in
 * <mark>. Terms come from the BM25 tokenizer, so they are alphanumeric and
 * survive escaping unchanged. The returned HTML is safe to render.
 */
export function highlightTerms(text: string, terms: string[]): string {
  const escaped = escapeHtml(text);

  const unique = Array.from(
    new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean)),
  );

  if (unique.length === 0) {
    return escaped;
  }

  const pattern = unique
    .sort((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  const regex = new RegExp(`\\b(${pattern})\\b`, "gi");

  return escaped.replace(regex, "<mark>$1</mark>");
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm test src/lib/highlight.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/highlight.ts src/lib/highlight.test.ts
git commit -m "feat: add html-escaping keyword highlighter"
```

## Task 5: Add Chunks Table And ChunkRepo

**Files:**
- Modify: `src/worker/repository/db.ts`
- Create: `src/worker/repository/ChunkRepo.test.ts`
- Create: `src/worker/repository/ChunkRepo.ts`

- [ ] **Step 1: Add the chunks table at schema version 2**

Replace `src/worker/repository/db.ts` with:

```ts
import Dexie, { type Table } from "dexie";

import type { ChunkRecord, PageRecord } from "../../shared/types";

export class DevRecallDatabase extends Dexie {
  pages!: Table<PageRecord, string>;
  chunks!: Table<ChunkRecord, string>;

  constructor(name = "devrecall") {
    super(name);

    this.version(1).stores({
      pages: "&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]",
    });

    this.version(2).stores({
      pages: "&id, urlHash, savedAt, domain, sourceType, status, [sourceType+savedAt]",
      chunks: "&id, pageId, [pageId+ordinal]",
    });
  }
}

export const db = new DevRecallDatabase();
```

- [ ] **Step 2: Write failing ChunkRepo tests**

Create `src/worker/repository/ChunkRepo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { ChunkRepo } from "./ChunkRepo";
import { DevRecallDatabase } from "./db";

describe("ChunkRepo", () => {
  let database: DevRecallDatabase;
  let repo: ChunkRepo;

  beforeEach(async () => {
    database = new DevRecallDatabase(`devrecall-test-${crypto.randomUUID()}`);
    repo = new ChunkRepo(database);
    await database.delete();
    await database.open();
  });

  it("stores chunks with sequential ordinals", async () => {
    const chunks = await repo.replaceChunksForPage("page-1", [
      "first chunk",
      "second chunk",
    ]);

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1]);
    expect(chunks.every((chunk) => chunk.pageId === "page-1")).toBe(true);

    const stored = await repo.allChunks();
    expect(stored).toHaveLength(2);
  });

  it("replaces a page's chunks instead of appending", async () => {
    await repo.replaceChunksForPage("page-1", ["old a", "old b", "old c"]);
    await repo.replaceChunksForPage("page-1", ["new a"]);

    const stored = await repo.allChunks();

    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("new a");
  });

  it("leaves other pages' chunks untouched when replacing", async () => {
    await repo.replaceChunksForPage("page-1", ["a"]);
    await repo.replaceChunksForPage("page-2", ["b"]);
    await repo.replaceChunksForPage("page-1", ["a2"]);

    const stored = await repo.allChunks();

    expect(stored).toHaveLength(2);
    expect(stored.map((chunk) => chunk.text).sort()).toEqual(["a2", "b"]);
  });

  it("deletes a page's chunks", async () => {
    await repo.replaceChunksForPage("page-1", ["a", "b"]);
    await repo.deleteForPage("page-1");

    expect(await repo.allChunks()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm test src/worker/repository/ChunkRepo.test.ts
```

Expected: FAIL with `Failed to resolve import "./ChunkRepo"`.

- [ ] **Step 4: Add ChunkRepo implementation**

Create `src/worker/repository/ChunkRepo.ts`:

```ts
import { ulid } from "ulid";

import type { ChunkRecord } from "../../shared/types";
import { db, type DevRecallDatabase } from "./db";

export class ChunkRepo {
  constructor(private readonly database: DevRecallDatabase = db) {}

  async replaceChunksForPage(
    pageId: string,
    texts: string[],
  ): Promise<ChunkRecord[]> {
    const chunks: ChunkRecord[] = texts.map((text, ordinal) => ({
      id: ulid(),
      pageId,
      ordinal,
      text,
      schemaVersion: 1,
    }));

    await this.database.transaction("rw", this.database.chunks, async () => {
      await this.database.chunks.where("pageId").equals(pageId).delete();

      if (chunks.length > 0) {
        await this.database.chunks.bulkPut(chunks);
      }
    });

    return chunks;
  }

  async allChunks(): Promise<ChunkRecord[]> {
    return this.database.chunks.toArray();
  }

  async deleteForPage(pageId: string): Promise<void> {
    await this.database.chunks.where("pageId").equals(pageId).delete();
  }
}
```

- [ ] **Step 5: Verify tests pass**

```bash
pnpm test src/worker/repository/ChunkRepo.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/repository/db.ts src/worker/repository/ChunkRepo.ts src/worker/repository/ChunkRepo.test.ts
git commit -m "feat: persist page chunks in a dexie table"
```

## Task 6: Chunk On Capture

**Files:**
- Modify: `src/worker/services/CaptureService.ts`
- Modify: `src/worker/services/CaptureService.test.ts`

- [ ] **Step 1: Update the CaptureService save test for chunk writing**

In `src/worker/services/CaptureService.test.ts`, extend the imports to pull in the new `ChunkWriter` port:

```ts
import {
  CaptureService,
  type ChunkWriter,
  type PageExtractor,
  type PageReader,
  type PageTagger,
  type PageWriter,
} from "./CaptureService";
```

Replace the first test (`"extracts the tab and stores a pending page"`) with:

```ts
  it("extracts the tab, stores a pending page, and writes chunks", async () => {
    const extractor: PageExtractor = {
      extract: vi.fn().mockResolvedValue(extracted),
    };
    const writer: PageWriter = {
      upsertCapturedPage: vi.fn().mockResolvedValue(pendingPage),
    };
    const chunkWriter: ChunkWriter = {
      replaceChunksForPage: vi.fn().mockResolvedValue([]),
    };

    const result = await new CaptureService(
      writer,
      extractor,
      undefined,
      undefined,
      chunkWriter,
    ).save(123);

    expect(extractor.extract).toHaveBeenCalledWith(123);
    expect(writer.upsertCapturedPage).toHaveBeenCalledWith({
      ...extracted,
      saveMode: "manual",
    });
    expect(chunkWriter.replaceChunksForPage).toHaveBeenCalledWith(
      pendingPage.id,
      [pendingPage.fullText],
    );
    expect(result).toBe(pendingPage);
  });
```

(`pendingPage.fullText` is `"Autoscaling docs"`, a single short chunk, so the expected chunk array is `[pendingPage.fullText]`.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/worker/services/CaptureService.test.ts
```

Expected: FAIL because `ChunkWriter` is not exported and the constructor has no `chunkWriter` parameter.

- [ ] **Step 3: Update CaptureService implementation**

Replace `src/worker/services/CaptureService.ts` with:

```ts
import type {
  ContentExtractRequest,
  ContentExtractResponse,
} from "../../shared/messages";
import type {
  ChunkRecord,
  ExtractedPage,
  PageCaptureInput,
  PageRecord,
} from "../../shared/types";
import { chunkText } from "../../lib/chunking";
import {
  OpenAIProvider,
  type PageTagger as OpenAIPageTagger,
} from "../llm/OpenAIProvider";
import { ChunkRepo } from "../repository/ChunkRepo";
import { PageRepo } from "../repository/PageRepo";

export type PageExtractor = {
  extract(tabId: number): Promise<ExtractedPage>;
};

export type PageWriter = {
  upsertCapturedPage(input: PageCaptureInput): Promise<PageRecord>;
};

export type PageReader = {
  getById(id: string): Promise<PageRecord | undefined>;
  updatePage(
    id: string,
    data: Partial<Omit<PageRecord, "id" | "schemaVersion">>,
  ): Promise<void>;
};

export type ChunkWriter = {
  replaceChunksForPage(pageId: string, texts: string[]): Promise<ChunkRecord[]>;
};

export type PageTagger = OpenAIPageTagger;

export class ChromePageExtractor implements PageExtractor {
  async extract(tabId: number): Promise<ExtractedPage> {
    if (typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
      throw new Error("Chrome tabs messaging is unavailable");
    }

    const request: ContentExtractRequest = { type: "content.extract" };
    const response = (await chrome.tabs.sendMessage(
      tabId,
      request,
    )) as ContentExtractResponse;

    if (response.type === "content.extractFailed") {
      throw new Error(response.payload.message);
    }

    return response.payload;
  }
}

export class CaptureService {
  constructor(
    private readonly writer: PageWriter = new PageRepo(),
    private readonly extractor: PageExtractor = new ChromePageExtractor(),
    private readonly reader: PageReader = new PageRepo(),
    private readonly tagger: PageTagger = new OpenAIProvider(),
    private readonly chunkWriter: ChunkWriter = new ChunkRepo(),
  ) {}

  async save(tabId: number): Promise<PageRecord> {
    const extracted = await this.extractor.extract(tabId);

    const page = await this.writer.upsertCapturedPage({
      ...extracted,
      saveMode: "manual",
    });

    await this.chunkWriter.replaceChunksForPage(
      page.id,
      chunkText(page.fullText),
    );

    return page;
  }

  async processPage(pageId: string, apiKey: string): Promise<PageRecord> {
    const page = await this.reader.getById(pageId);

    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }

    try {
      const result = await this.tagger.summarizeAndTag(
        page.fullText,
        page.title,
        page.url,
        apiKey,
      );

      await this.reader.updatePage(pageId, { ...result, status: "ready" });

      return { ...page, ...result, status: "ready" };
    } catch (error) {
      const errorReason =
        error instanceof Error ? error.message : "Unknown error";

      await this.reader.updatePage(pageId, {
        status: "failed",
        errorReason,
      });

      return { ...page, status: "failed", errorReason };
    }
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm test src/worker/services/CaptureService.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/services/CaptureService.ts src/worker/services/CaptureService.test.ts
git commit -m "feat: write chunks when a page is captured"
```

## Task 7: Add RetrievalService

**Files:**
- Create: `src/worker/services/RetrievalService.test.ts`
- Create: `src/worker/services/RetrievalService.ts`

- [ ] **Step 1: Write failing RetrievalService tests**

Create `src/worker/services/RetrievalService.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { ChunkRecord, PageRecord } from "../../shared/types";
import {
  RetrievalService,
  type ChunkSource,
  type PageSource,
} from "./RetrievalService";

function chunk(
  id: string,
  pageId: string,
  ordinal: number,
  text: string,
): ChunkRecord {
  return { id, pageId, ordinal, text, schemaVersion: 1 };
}

function page(id: string, title: string, domain: string): PageRecord {
  return {
    id,
    url: `https://${domain}/${id}`,
    urlHash: id.padEnd(64, "0"),
    title,
    domain,
    sourceType: "official_docs",
    summary: "",
    topics: ["kubernetes"],
    technologies: ["Kubernetes"],
    intent: "reference",
    fullText: "",
    savedAt: 100,
    visitedAt: 100,
    readingTimeMs: 1000,
    saveMode: "manual",
    status: "ready",
    schemaVersion: 1,
  };
}

const chunks = [
  chunk("c1", "p1", 0, "horizontal pod autoscaler automatically scales pods"),
  chunk("c2", "p2", 0, "react hydration mismatch during rendering"),
  chunk("c3", "p1", 1, "the autoscaler watches metrics"),
];

const pages = new Map<string, PageRecord>([
  ["p1", page("p1", "Horizontal Pod Autoscaling", "kubernetes.io")],
  ["p2", page("p2", "React hydration", "github.com")],
]);

function makeService(): RetrievalService {
  const chunkSource: ChunkSource = {
    allChunks: vi.fn().mockResolvedValue(chunks),
  };
  const pageSource: PageSource = {
    getById: vi.fn().mockImplementation((id: string) => pages.get(id)),
  };

  return new RetrievalService(chunkSource, pageSource);
}

describe("RetrievalService", () => {
  it("returns an empty array for a blank query", async () => {
    await expect(makeService().search("   ")).resolves.toEqual([]);
  });

  it("returns the best-matching page with a highlighted chunk", async () => {
    const hits = await makeService().search("autoscale pods");

    expect(hits).toHaveLength(1);
    expect(hits[0].page.id).toBe("p1");
    expect(hits[0].page.title).toBe("Horizontal Pod Autoscaling");
    expect(hits[0].matchReason).toBe("keyword");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].bestChunk.highlightedHtml).toContain("<mark>pods</mark>");
  });

  it("keeps only the highest-scoring chunk per page", async () => {
    const hits = await makeService().search("autoscaler pods");

    expect(hits).toHaveLength(1);
    expect(hits[0].bestChunk.ordinal).toBe(0);
  });

  it("honors the topK option", async () => {
    const hits = await makeService().search("autoscaler hydration", {
      topK: 1,
    });

    expect(hits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/worker/services/RetrievalService.test.ts
```

Expected: FAIL with `Failed to resolve import "./RetrievalService"`.

- [ ] **Step 3: Add RetrievalService implementation**

Create `src/worker/services/RetrievalService.ts`:

```ts
import { bm25Search } from "../../lib/bm25";
import { highlightTerms } from "../../lib/highlight";
import type { ChunkRecord, PageHit, PageRecord } from "../../shared/types";
import { ChunkRepo } from "../repository/ChunkRepo";
import { PageRepo, toPageListItem } from "../repository/PageRepo";

export type ChunkSource = {
  allChunks(): Promise<ChunkRecord[]>;
};

export type PageSource = {
  getById(id: string): Promise<PageRecord | undefined>;
};

export type SearchOptions = {
  topK?: number;
};

const DEFAULT_TOP_K = 10;

type RankedChunk = {
  chunk: ChunkRecord;
  score: number;
  matchedTerms: string[];
};

export class RetrievalService {
  constructor(
    private readonly chunks: ChunkSource = new ChunkRepo(),
    private readonly pages: PageSource = new PageRepo(),
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<PageHit[]> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const allChunks = await this.chunks.allChunks();

    if (allChunks.length === 0) {
      return [];
    }

    const hits = bm25Search(
      trimmed,
      allChunks.map((chunk) => chunk.text),
    );

    if (hits.length === 0) {
      return [];
    }

    const bestByPage = new Map<string, RankedChunk>();
    for (const hit of hits) {
      const chunk = allChunks[hit.index];
      const current = bestByPage.get(chunk.pageId);

      if (!current || hit.score > current.score) {
        bestByPage.set(chunk.pageId, {
          chunk,
          score: hit.score,
          matchedTerms: hit.matchedTerms,
        });
      }
    }

    const ranked = Array.from(bestByPage.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);

    const results: PageHit[] = [];
    for (const entry of ranked) {
      const page = await this.pages.getById(entry.chunk.pageId);

      if (!page) {
        continue;
      }

      results.push({
        page: toPageListItem(page),
        bestChunk: {
          text: entry.chunk.text,
          ordinal: entry.chunk.ordinal,
          highlightedHtml: highlightTerms(entry.chunk.text, entry.matchedTerms),
        },
        score: entry.score,
        matchReason: "keyword",
      });
    }

    return results;
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm test src/worker/services/RetrievalService.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/services/RetrievalService.ts src/worker/services/RetrievalService.test.ts
git commit -m "feat: add keyword retrieval service"
```

## Task 8: Wire Worker Dispatch

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/worker/index.test.ts`

- [ ] **Step 1: Extend worker tests with search dispatch**

In `src/worker/index.test.ts`, add `PageHit` to the type import on line 5:

```ts
import type { PageHit, PageListItem, PageRecord } from "../shared/types";
```

Add a `searchHit` fixture after `pendingListItem` (after line 39):

```ts
const searchHit = {
  page: pendingListItem,
  bestChunk: {
    text: "IndexedDB stores structured data.",
    ordinal: 0,
    highlightedHtml: "IndexedDB stores <mark>structured</mark> data.",
  },
  score: 1.5,
  matchReason: "keyword",
} satisfies PageHit;
```

Add this test inside the `describe("worker request handler", ...)` block, after the `"lists saved pages through PageRepo"` test:

```ts
  it("runs a keyword search through RetrievalService", async () => {
    const deps = makeDeps();
    deps.retrievalService.search = vi.fn().mockResolvedValue([searchHit]);

    await expect(
      handleRequest(
        { type: "search.run", payload: { query: "structured data" } },
        deps,
      ),
    ).resolves.toEqual({
      type: "search.results",
      payload: { hits: [searchHit] },
    });
    expect(deps.retrievalService.search).toHaveBeenCalledWith("structured data", {
      topK: undefined,
    });
  });
```

In the `makeDeps` helper, add a `retrievalService` mock to the returned object (after the `testConnection` mock):

```ts
    testConnection: vi
      .fn()
      .mockResolvedValue(
        overrides.connectionResult ?? {
          success: true,
          message: "Connection successful",
        },
      ),
    retrievalService: {
      search: vi.fn().mockResolvedValue([]),
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/worker/index.test.ts
```

Expected: FAIL because `HandlerDeps` has no `retrievalService` and `search.run` is unhandled.

- [ ] **Step 3: Wire RetrievalService into the dispatcher**

In `src/worker/index.ts`, update the imports near the top. Add `PageHit` to the shared-types import and add the new service/repo imports:

```ts
import type { PageHit, PageListItem, PageRecord } from "../shared/types";
import { normalizeUrl } from "../lib/urlNormalize";
import {
  testOpenAIConnection,
} from "./llm/OpenAIProvider";
import { ChunkRepo } from "./repository/ChunkRepo";
import { PageRepo, toPageListItem } from "./repository/PageRepo";
import { CaptureService } from "./services/CaptureService";
import { RetrievalService } from "./services/RetrievalService";
import { ChromeApiKeyStore, type ApiKeyStore } from "./settings/ApiKeyStore";
```

Add a `SearchPort` type next to the existing `CapturePort` / `PageListPort` types:

```ts
type SearchPort = {
  search(query: string, options?: { topK?: number }): Promise<PageHit[]>;
};
```

Add `retrievalService` to `HandlerDeps`:

```ts
type HandlerDeps = {
  captureService: CapturePort;
  pageRepo: PageListPort;
  apiKeyStore: ApiKeyStore;
  testConnection: (
    apiKey: string,
  ) => Promise<{ success: boolean; message: string }>;
  retrievalService: SearchPort;
};
```

Update the default-deps wiring to construct a shared `ChunkRepo`, pass it into `CaptureService`, and build a `RetrievalService`:

```ts
const pageRepo = new PageRepo();
const chunkRepo = new ChunkRepo();
const defaultDeps: HandlerDeps = {
  captureService: new CaptureService(pageRepo, undefined, pageRepo, undefined, chunkRepo),
  pageRepo,
  apiKeyStore: new ChromeApiKeyStore(),
  testConnection: testOpenAIConnection,
  retrievalService: new RetrievalService(chunkRepo, pageRepo),
};
```

Add the `search.run` case to the `switch` (before the `default` branch):

```ts
    case "search.run":
      return {
        type: "search.results",
        payload: {
          hits: await deps.retrievalService.search(request.payload.query, {
            topK: request.payload.topK,
          }),
        },
      };

    default:
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm test src/worker/index.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts src/worker/index.test.ts
git commit -m "feat: dispatch keyword search in the worker"
```

## Task 9: Wire Side Panel Search UI

**Files:**
- Create: `src/ui/components/SearchResultCard.tsx`
- Modify: `src/ui/components/index.ts`
- Modify: `src/sidepanel/App.test.tsx`
- Modify: `src/sidepanel/App.tsx`

- [ ] **Step 1: Add the SearchResultCard component**

Create `src/ui/components/SearchResultCard.tsx`:

```tsx
import type { PageHit } from "../../shared/types";

type SearchResultCardProps = {
  hit: PageHit;
};

export function SearchResultCard({ hit }: SearchResultCardProps) {
  const { page, bestChunk, matchReason } = hit;

  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          <a
            href={page.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {page.title}
          </a>
        </h2>
        <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
          {matchReason}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-500">{page.domain}</p>

      <p
        className="mt-2 text-sm text-slate-600 [&_mark]:rounded [&_mark]:bg-amber-200 [&_mark]:px-0.5 [&_mark]:text-slate-900"
        dangerouslySetInnerHTML={{ __html: bestChunk.highlightedHtml }}
      />

      {page.topics.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {page.topics.map((topic) => (
            <span
              key={topic}
              className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
            >
              {topic}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
```

The `highlightedHtml` is produced by the worker from already-escaped text (Task 4), so rendering it with `dangerouslySetInnerHTML` is safe.

Modify `src/ui/components/index.ts`:

```ts
export { PageCard } from "./PageCard";
export { SearchResultCard } from "./SearchResultCard";
export { SurfaceShell } from "./SurfaceShell";
```

- [ ] **Step 2: Extend side panel tests with search coverage**

Replace `src/sidepanel/App.test.tsx` with:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PageHit, PageListItem } from "../shared/types";
import { App } from "./App";

const pages = [
  {
    id: "01HZ0000000000000000000000",
    url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
    title: "Horizontal Pod Autoscaling",
    domain: "kubernetes.io",
    sourceType: "unknown",
    summary: "",
    topics: [],
    technologies: [],
    savedAt: 100,
    status: "ready",
  },
] satisfies PageListItem[];

const hits = [
  {
    page: pages[0],
    bestChunk: {
      text: "The HorizontalPodAutoscaler automatically scales pods.",
      ordinal: 0,
      highlightedHtml:
        "The HorizontalPodAutoscaler automatically scales <mark>pods</mark>.",
    },
    score: 2.1,
    matchReason: "keyword",
  },
] satisfies PageHit[];

describe("Side panel app", () => {
  it("renders the library search shell", async () => {
    render(
      <App listPages={vi.fn().mockResolvedValue([])} runSearch={vi.fn()} />,
    );

    expect(
      screen.getByRole("heading", { name: "DevRecall" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search saved pages" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("No saved pages yet")).toBeInTheDocument();
  });

  it("lists saved pages from the worker", async () => {
    const listPages = vi.fn().mockResolvedValue(pages);

    render(<App listPages={listPages} runSearch={vi.fn()} />);

    expect(listPages).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", {
        name: "Horizontal Pod Autoscaling",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("kubernetes.io")).toBeInTheDocument();
  });

  it("runs a keyword search and shows highlighted results", async () => {
    const user = userEvent.setup();
    const runSearch = vi.fn().mockResolvedValue(hits);

    render(
      <App listPages={vi.fn().mockResolvedValue([])} runSearch={runSearch} />,
    );

    await user.type(
      screen.getByRole("searchbox", { name: "Search saved pages" }),
      "autoscale pods",
    );

    expect(
      await screen.findByRole("heading", {
        name: "Horizontal Pod Autoscaling",
      }),
    ).toBeInTheDocument();
    expect(runSearch).toHaveBeenCalledWith("autoscale pods");
    expect(screen.getByText("keyword")).toBeInTheDocument();
  });

  it("shows an empty-search message when nothing matches", async () => {
    const user = userEvent.setup();
    const runSearch = vi.fn().mockResolvedValue([]);

    render(
      <App listPages={vi.fn().mockResolvedValue([])} runSearch={runSearch} />,
    );

    await user.type(
      screen.getByRole("searchbox", { name: "Search saved pages" }),
      "nomatch",
    );

    expect(
      await screen.findByText("No matches for your search"),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm test src/sidepanel/App.test.tsx
```

Expected: FAIL because `App` does not accept `runSearch` and does not render search results.

- [ ] **Step 4: Wire the search box in App**

Replace `src/sidepanel/App.tsx` with:

```tsx
import { useEffect, useState } from "react";

import type { DevRecallRequest, DevRecallResponse } from "../shared/messages";
import type { PageHit, PageListItem } from "../shared/types";
import { PageCard, SearchResultCard, SurfaceShell } from "../ui/components";

const filters = ["All", "Docs", "SO", "GH"] as const;

type AppProps = {
  listPages?: () => Promise<PageListItem[]>;
  runSearch?: (query: string) => Promise<PageHit[]>;
};

async function defaultListPages(): Promise<PageListItem[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }

  try {
    const request: DevRecallRequest = {
      type: "page.list",
      payload: { limit: 50 },
    };
    const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;

    if (response.type !== "page.listed") {
      return [];
    }

    return response.payload.pages ?? [];
  } catch {
    return [];
  }
}

async function defaultRunSearch(query: string): Promise<PageHit[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }

  try {
    const request: DevRecallRequest = {
      type: "search.run",
      payload: { query },
    };
    const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;

    if (response.type !== "search.results") {
      return [];
    }

    return response.payload.hits ?? [];
  } catch {
    return [];
  }
}

export function App({
  listPages = defaultListPages,
  runSearch = defaultRunSearch,
}: AppProps) {
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hits, setHits] = useState<PageHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadPages() {
      setLoading(true);
      try {
        const nextPages = await listPages();

        if (!cancelled) {
          setPages(nextPages);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setPages([]);
          setLoading(false);
        }
      }
    }

    void loadPages();

    return () => {
      cancelled = true;
    };
  }, [listPages]);

  useEffect(() => {
    const handle = setTimeout(() => setSubmittedQuery(query.trim()), 200);

    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (submittedQuery.length === 0) {
      setHits([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    void runSearch(submittedQuery).then((nextHits) => {
      if (!cancelled) {
        setHits(nextHits);
        setSearching(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [submittedQuery, runSearch]);

  const isSearching = submittedQuery.length > 0;

  return (
    <SurfaceShell
      title="DevRecall"
      actions={
        <button
          type="button"
          aria-label="Settings"
          className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Settings
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <input
          type="search"
          aria-label="Search saved pages"
          placeholder="Search saved pages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <div className="flex gap-2">
          {filters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filter === "All"}
              className="rounded-md border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 aria-pressed:border-accent aria-pressed:text-accent"
            >
              {filter}
            </button>
          ))}
        </div>

        {isSearching ? (
          searching ? (
            <p className="text-sm text-slate-500">Searching...</p>
          ) : hits.length === 0 ? (
            <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
              <h2 className="text-sm font-semibold text-slate-900">
                No matches for your search
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Try different keywords.
              </p>
            </section>
          ) : (
            <div className="flex flex-col gap-3">
              {hits.map((hit) => (
                <SearchResultCard key={hit.page.id} hit={hit} />
              ))}
            </div>
          )
        ) : loading ? (
          <p className="text-sm text-slate-500">Loading library...</p>
        ) : pages.length === 0 ? (
          <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
            <h2 className="text-sm font-semibold text-slate-900">No saved pages yet</h2>
            <p className="mt-2 text-sm text-slate-500">Saved pages will appear here.</p>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {pages.map((page) => (
              <PageCard key={page.id} page={page} />
            ))}
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}
```

- [ ] **Step 5: Verify tests pass**

```bash
pnpm test src/sidepanel/App.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/SearchResultCard.tsx src/ui/components/index.ts src/sidepanel/App.tsx src/sidepanel/App.test.tsx
git commit -m "feat: wire side panel keyword search"
```

## Task 10: Final M4 Verification

**Files:**
- Review all files changed in Tasks 1-9.

- [ ] **Step 1: Run the full automated suite**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all commands pass.

- [ ] **Step 2: Confirm coverage on new lib and service code**

```bash
pnpm test -- --coverage
```

Expected: `src/lib/chunking.ts`, `src/lib/bm25.ts`, `src/lib/highlight.ts`, and `src/worker/services/RetrievalService.ts` are ≥80% covered (the M4 spec coverage target).

- [ ] **Step 3: Manually smoke test the extension build**

```bash
pnpm dev
```

Load the extension from `dist/` in Chrome, then:

1. Save 2-3 technical pages (e.g. a Kubernetes HPA page and a Stack Overflow answer) via the popup. No API key is required for keyword search.
2. Open the side panel; confirm the saved pages appear in the library.
3. Type a query that appears in one page's text. Confirm:
   - A result card appears with the matching page's title and domain.
   - The query term is wrapped in a highlight (`<mark>`) inside the chunk preview.
   - A "keyword" badge is shown.
4. Clear the search box. Confirm the library view returns.
5. Type a query that matches nothing. Confirm "No matches for your search".

Expected: keyword search returns the right pages with highlighted chunks, independent of any API key.

- [ ] **Step 4: Check M4 scope boundaries**

```bash
rg -n "embedding|Float32Array|cosine|rrf|reciprocal|tiktoken|corpusStats|auto.?save" src
```

Expected: no matches in M4 implementation files. Embeddings, vector search, RRF, token-based chunking, the corpusStats table, and auto-save are all M5/M6.

- [ ] **Step 5: Inspect git diff**

```bash
git status --short
git diff --stat
```

Expected: only the M4 plan file and M4 implementation/test files are changed.

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "feat: complete keyword search milestone"
```

## Self-Review Notes

- **Spec coverage.** M4 in the spec (§14) is "Side panel search box runs BM25 over chunks-of-fullText (simple chunking, no embeddings yet). Results show match highlighting." Tasks 2-4 build the pure pieces (chunking, BM25, highlight), Tasks 5-7 persist chunks and add retrieval, Tasks 8-9 wire the worker and UI.
- **Chunking is independent of the LLM.** Chunks are written in `CaptureService.save` (Task 6), not in `processPage`, so keyword search works with no API key. This is a deliberate, user-visible property worth keeping.
- **`corpusStats` table is intentionally deferred.** The spec data model (§5) lists a `corpusStats` table whose only consumer is BM25's `avgdl`. M4's retrieval already loads the full chunk set into memory for the full scan (per the spec's retrieval design, §7), so `bm25Search` derives `avgdl` from that in-memory corpus directly. This removes an extra table and the transactional stat-update bookkeeping on every upsert/delete without changing scoring. Revisit in M5 only if an inverted index or out-of-core scan makes loading all chunks undesirable.
- **No in-memory chunk cache yet.** `RetrievalService` reads chunks from IndexedDB per query. The spec's preloaded-and-refreshed-on-broadcast array is an M5+ performance optimization; per-query reads are simpler and survive the MV3 worker being killed. Fine for a portfolio-scale corpus.
- **Re-save correctness.** `ChunkRepo.replaceChunksForPage` deletes a page's existing chunks before inserting new ones inside one `rw` transaction, so re-saving a URL never leaves stale or duplicated chunks. Delete-on-page-removal (`deleteForPage`) exists but is not yet wired to a delete flow (no delete UI until M6).
- **Highlighting safety.** `highlightTerms` escapes the chunk text before inserting `<mark>`, and matched terms come from the alphanumeric BM25 tokenizer, so the only HTML in `highlightedHtml` is the marks the worker added. The side panel renders it with `dangerouslySetInnerHTML`; ESLint here has no `react/no-danger` rule, so no disable directive is needed.
- **Type consistency.** `ChunkRecord`, `PageHit`, and the `search.run`/`search.results` messages are defined once in `src/shared` and reused across `ChunkRepo`, `RetrievalService`, the worker dispatcher, and the side panel. `PageHit.page` reuses the existing `PageListItem` DTO rather than introducing a parallel shape.
- **Schema migration.** `db.ts` keeps the version(1) `pages` declaration and adds version(2) with the `chunks` table, so existing installs upgrade in place without dropping saved pages.
- **M5 hooks.** `SearchMatchReason` is a single-member union (`"keyword"`) that M5 widens to `"vector" | "both"`; `ChunkRecord` gains `embedding`/`embeddingModel`/`tokenCount` in M5; `chunkText` is replaced by token-based chunking. None of these require reshaping the M4 message contract.
```