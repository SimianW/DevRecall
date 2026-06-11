# M5a — Retrieval Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four pure functions M5's hybrid retrieval rests on — token-based chunking, vector math, Reciprocal Rank Fusion, and a CJK-aware keyword tokenizer — each fully unit-tested, with no application wiring yet.

**Architecture:** This is the first of four M5 plans (M5a → M5b → M5c → M5d). It adds only pure modules under `src/lib/`, plus one new dependency (`js-tiktoken`). Nothing in the running extension changes: the new functions are exercised only by their tests until M5b/M5c import them. Because every module is pure (no `chrome.*`, no Dexie, no `fetch`), each is trivially testable and the build stays green throughout.

**Tech Stack:** TypeScript strict mode, Vitest, `js-tiktoken` (pure-JS BPE tokenizer, bundled rank data — no WASM).

**Parent spec:** [`docs/superpowers/specs/2026-05-31-m5-hybrid-retrieval-design.md`](../specs/2026-05-31-m5-hybrid-retrieval-design.md) — §6.2 (vector arm), §6.3 (RRF), §6.4 (CJK), §8 (new files).

---

## Scope

M5a implements pure retrieval primitives only:

- `lib/tokenChunking.ts` — `chunkTokens(text, { maxTokens, overlap })` using `js-tiktoken` (`cl100k_base`, the `text-embedding-3-small` encoding). Returns `{ text, tokenCount }[]`. Separate from M4's word-window `lib/chunking.ts`, which stays for the pre-embedding `save()` path.
- `lib/vector.ts` — `normalize`, `dot`, `cosineTopK`. Operates on `Float32Array` and a minimal `{ embedding?: Float32Array }` shape, so it does **not** depend on `ChunkRecord` (that type only grows its `embedding` field in M5b).
- `lib/rrf.ts` — `reciprocalRankFusion(keywordRanking, vectorRanking, k=60)` over two ranked `string[]` id lists, plus `matchReasonFor`.
- `lib/bm25.ts` — `tokenize` extended to be script-aware: Latin/digit runs tokenize exactly as M4 (split on non-alphanumeric, drop stopwords); CJK runs emit character bigrams. `bm25Search` itself is unchanged.

Out of scope (later M5 plans):

- `ChunkRecord` embedding fields, `Embedder` port, OpenAI embedding calls, `MockLLMProvider`, `processPage` changes → **M5b**.
- `RetrievalService` hybrid wiring (consuming `vector.ts` + `rrf.ts`), `PageHit.scores`, query embedding → **M5c**.
- Broadcasts, delete, re-index, keyboard shortcut, in-memory chunk array + LRU cache, "matched by meaning" badge → **M5d**.

Nothing here changes runtime behavior. Keyword search keeps using M4's `bm25Search` over word-window chunks; the new CJK tokenizer is wired in automatically (it lives inside `tokenize`, which `bm25Search` already calls), so Chinese chunk/query text begins tokenizing into bigrams the moment this plan lands — but no new chunks or vectors exist yet.

Baseline before plan creation (run these to confirm green):

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all pass. The repository is at M4 (capture + LLM tagging + keyword search).

## File Structure

- Modify `package.json` / `pnpm-lock.yaml` — add `js-tiktoken` to `dependencies`.
- Create `src/lib/tokenChunking.ts` and `src/lib/tokenChunking.test.ts`.
- Create `src/lib/vector.ts` and `src/lib/vector.test.ts`.
- Create `src/lib/rrf.ts` and `src/lib/rrf.test.ts`.
- Modify `src/lib/bm25.ts` (only `tokenize`) and `src/lib/bm25.test.ts` (add CJK cases).

---

## Task 1: Add the js-tiktoken dependency

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml` (written by pnpm)

- [ ] **Step 1: Install js-tiktoken as a runtime dependency**

```bash
pnpm add js-tiktoken
```

Expected: `package.json` `dependencies` now lists `js-tiktoken` (a `1.x` version), and `pnpm-lock.yaml` is updated. `js-tiktoken` ships its BPE rank data as bundled JS (no WASM, no network fetch), which is what makes it safe inside an MV3 service worker.

- [ ] **Step 2: Confirm the encoding loads synchronously**

Run a throwaway check (do not commit this file):

```bash
node -e "const { getEncoding } = require('js-tiktoken'); const enc = getEncoding('cl100k_base'); const t = enc.encode('hello world'); console.log(t.length, enc.decode(t));"
```

Expected: prints a small token count (e.g. `2 hello world`) and the round-tripped string. This confirms `cl100k_base` (the `text-embedding-3-small` encoding) is available and that `encode`/`decode` round-trip losslessly on normal text.

- [ ] **Step 3: Verify the project still builds and tests pass**

```bash
pnpm typecheck
pnpm test
```

Expected: PASS. Adding the dependency changes no source yet.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: add js-tiktoken for token-based chunking"
```

---

## Task 2: Token-based chunking

**Files:**

- Create: `src/lib/tokenChunking.ts`
- Test: `src/lib/tokenChunking.test.ts`

The window math mirrors M4's `lib/chunking.ts` (`step = max - overlap`, break once the window reaches the end) but counts BPE tokens instead of words and decodes each token window back to text. `tokenCount` is the exact length of the original token slice (not a re-encode of the decoded text), so it is reliable metadata for the detail view and M6 storage stats.

- [ ] **Step 1: Write the failing test**

Create `src/lib/tokenChunking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getEncoding } from "js-tiktoken";

import { chunkTokens } from "./tokenChunking";

const enc = getEncoding("cl100k_base");

// A paragraph long enough to span several small windows.
const LONG_TEXT = (
  "DevRecall captures technical browsing sessions and lets developers retrieve " +
  "past documentation through natural-language search. It runs entirely on the " +
  "user's machine as a Chrome extension, summarizing and tagging each saved page " +
  "with a hosted language model and storing everything in IndexedDB. "
).repeat(4);

describe("chunkTokens", () => {
  it("returns a single chunk for short text with an exact token count", () => {
    const result = chunkTokens("hello world", { maxTokens: 500, overlap: 50 });

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("hello world");
    expect(result[0].tokenCount).toBe(enc.encode("hello world").length);
  });

  it("returns no chunks for blank or whitespace-only input", () => {
    expect(chunkTokens("", { maxTokens: 500, overlap: 50 })).toEqual([]);
    expect(chunkTokens("   \n\t ", { maxTokens: 500, overlap: 50 })).toEqual([]);
  });

  it("splits long text into overlapping token windows", () => {
    const maxTokens = 20;
    const overlap = 5;
    const step = maxTokens - overlap;

    const trimmed = LONG_TEXT.trim();
    const tokens = enc.encode(trimmed);
    expect(tokens.length).toBeGreaterThan(maxTokens); // fixture sanity

    const result = chunkTokens(trimmed, { maxTokens, overlap });

    // Reconstruct the expected windows the same way the implementation does.
    const expected: { text: string; tokenCount: number }[] = [];
    for (let start = 0; start < tokens.length; start += step) {
      const window = tokens.slice(start, start + maxTokens);
      expected.push({ text: enc.decode(window), tokenCount: window.length });
      if (start + maxTokens >= tokens.length) {
        break;
      }
    }

    expect(result).toEqual(expected);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("rejects invalid options", () => {
    expect(() => chunkTokens("x", { maxTokens: 0 })).toThrow();
    expect(() => chunkTokens("x", { maxTokens: 10, overlap: 10 })).toThrow();
    expect(() => chunkTokens("x", { maxTokens: 10, overlap: -1 })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/lib/tokenChunking.test.ts
```

Expected: FAIL — `Failed to resolve import "./tokenChunking"` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/tokenChunking.ts`:

```ts
import { getEncoding, type Tiktoken } from "js-tiktoken";

export type TokenChunk = {
  text: string;
  tokenCount: number;
};

export type TokenChunkOptions = {
  maxTokens?: number;
  overlap?: number;
};

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_OVERLAP = 50;

// Lazily instantiated so importing this module does not build the encoder until
// the first chunk is produced. The rank data is bundled by js-tiktoken either
// way; this only defers the (cheap) construction cost.
let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = getEncoding("cl100k_base");
  }
  return encoder;
}

/**
 * Splits text into overlapping token windows using the cl100k_base encoding
 * (the tokenizer for text-embedding-3-small). Each chunk's `tokenCount` is the
 * exact length of its source token window, suitable as stored metadata.
 *
 * Mirrors the window math of lib/chunking.ts but counts BPE tokens.
 */
export function chunkTokens(text: string, options: TokenChunkOptions = {}): TokenChunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;

  if (maxTokens <= 0) {
    throw new Error("maxTokens must be greater than 0");
  }

  if (overlap < 0 || overlap >= maxTokens) {
    throw new Error("overlap must be between 0 and maxTokens");
  }

  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return [];
  }

  const enc = getEncoder();
  const tokens = enc.encode(trimmed);

  if (tokens.length === 0) {
    return [];
  }

  const step = maxTokens - overlap;
  const chunks: TokenChunk[] = [];

  for (let start = 0; start < tokens.length; start += step) {
    const window = tokens.slice(start, start + maxTokens);
    chunks.push({ text: enc.decode(window), tokenCount: window.length });

    if (start + maxTokens >= tokens.length) {
      break;
    }
  }

  return chunks;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test src/lib/tokenChunking.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tokenChunking.ts src/lib/tokenChunking.test.ts
git commit -m "feat: add token-based chunking with js-tiktoken"
```

---

## Task 3: Vector math

**Files:**

- Create: `src/lib/vector.ts`
- Test: `src/lib/vector.test.ts`

`cosineTopK` is generic over `{ embedding?: Float32Array }` so it stays decoupled from `ChunkRecord` (whose `embedding` field arrives in M5b). It assumes both the query and every stored embedding are already L2-normalized, so cosine similarity is a plain dot product. Items without an `embedding` are skipped — that is the graceful-degradation path for M4 pages that predate embeddings.

- [ ] **Step 1: Write the failing test**

Create `src/lib/vector.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { cosineTopK, dot, normalize } from "./vector";

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe("normalize", () => {
  it("produces a unit vector", () => {
    const result = normalize(vec([3, 4]));

    expect(dot(result, result)).toBeCloseTo(1, 6);
    expect(result[0]).toBeCloseTo(0.6, 6);
    expect(result[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves an all-zero vector at zero", () => {
    const result = normalize(vec([0, 0, 0]));

    expect(Array.from(result)).toEqual([0, 0, 0]);
  });
});

describe("dot", () => {
  it("equals cosine for normalized vectors", () => {
    const a = normalize(vec([1, 0]));
    const b = normalize(vec([1, 1]));

    expect(dot(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("is 1 for a normalized vector with itself", () => {
    const a = normalize(vec([2, -5, 1]));

    expect(dot(a, a)).toBeCloseTo(1, 6);
  });

  it("throws on length mismatch", () => {
    expect(() => dot(vec([1, 2]), vec([1, 2, 3]))).toThrow();
  });
});

describe("cosineTopK", () => {
  const query = normalize(vec([1, 0]));
  const items = [
    { id: "far", embedding: normalize(vec([0, 1])) }, // orthogonal → 0
    { id: "near", embedding: normalize(vec([1, 0.1])) }, // close → ~1
    { id: "mid", embedding: normalize(vec([1, 1])) }, // 45° → ~0.707
    { id: "novec" }, // no embedding → skipped
  ];

  it("ranks by similarity and keeps top-K", () => {
    const hits = cosineTopK(query, items, 2);

    expect(hits).toHaveLength(2);
    expect(items[hits[0].index].id).toBe("near");
    expect(items[hits[1].index].id).toBe("mid");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("skips items without an embedding", () => {
    const hits = cosineTopK(query, items, 10);

    expect(hits).toHaveLength(3); // "novec" excluded
    expect(hits.map((h) => items[h.index].id)).not.toContain("novec");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/lib/vector.test.ts
```

Expected: FAIL — `Failed to resolve import "./vector"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/vector.ts`:

```ts
/**
 * Pure vector math for the M5 vector-search arm. No chrome.*, no Dexie — the
 * embedding shape is a structural `{ embedding?: Float32Array }` so this module
 * stays decoupled from the ChunkRecord data type.
 */

export function normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) {
    sumSquares += vector[i] * vector[i];
  }

  const result = new Float32Array(vector.length);
  const magnitude = Math.sqrt(sumSquares);

  if (magnitude === 0) {
    return result; // all-zero vector has no direction; leave it at zero
  }

  for (let i = 0; i < vector.length; i += 1) {
    result[i] = vector[i] / magnitude;
  }

  return result;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }

  return sum;
}

export type EmbeddedItem = { embedding?: Float32Array };

export type VectorHit = {
  index: number;
  score: number;
};

/**
 * Full-scan top-K by cosine similarity. Assumes the query and every item's
 * embedding are pre-normalized, so cosine == dot product. Items without an
 * embedding are skipped (M4 pages that predate embeddings).
 */
export function cosineTopK<T extends EmbeddedItem>(
  query: Float32Array,
  items: readonly T[],
  topK: number,
): VectorHit[] {
  const hits: VectorHit[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const embedding = items[index].embedding;

    if (!embedding) {
      continue;
    }

    hits.push({ index, score: dot(query, embedding) });
  }

  hits.sort((left, right) => right.score - left.score);

  return hits.slice(0, topK);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test src/lib/vector.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/vector.ts src/lib/vector.test.ts
git commit -m "feat: add pure vector math for cosine search"
```

---

## Task 4: Reciprocal Rank Fusion

**Files:**

- Create: `src/lib/rrf.ts`
- Test: `src/lib/rrf.test.ts`

RRF fuses two ranked id lists by summing `1 / (k + rank)` across the lists in which each id appears, with `rank` 1-based (the top result is rank 1). Because it is rank-based, it ignores that BM25 scores live in `[0, ~10]` and cosine in `[-1, 1]` — no score normalization needed. The per-arm membership flags drive `matchReason`: an id present only in the vector list is the "matched by meaning" case.

- [ ] **Step 1: Write the failing test**

Create `src/lib/rrf.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_RRF_K, matchReasonFor, reciprocalRankFusion } from "./rrf";

describe("reciprocalRankFusion", () => {
  it("scores a single-list id by its 1-based rank", () => {
    const fused = reciprocalRankFusion(["a", "b"], []);

    expect(fused.get("a")?.fused).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 9);
    expect(fused.get("b")?.fused).toBeCloseTo(1 / (DEFAULT_RRF_K + 2), 9);
    expect(fused.get("a")?.inKeyword).toBe(true);
    expect(fused.get("a")?.inVector).toBe(false);
  });

  it("sums contributions for an id present in both lists", () => {
    const fused = reciprocalRankFusion(["x"], ["x"]);
    const entry = fused.get("x");

    expect(entry?.fused).toBeCloseTo(2 / (DEFAULT_RRF_K + 1), 9);
    expect(entry?.inKeyword).toBe(true);
    expect(entry?.inVector).toBe(true);
  });

  it("ranks a both-lists id above single-list ids", () => {
    // "both" is rank 2 in each list; "kw" is rank 1 in keyword only.
    const fused = reciprocalRankFusion(["kw", "both"], ["vec", "both"]);

    const both = fused.get("both")?.fused ?? 0;
    const kw = fused.get("kw")?.fused ?? 0;
    const vec = fused.get("vec")?.fused ?? 0;

    expect(both).toBeGreaterThan(kw);
    expect(both).toBeGreaterThan(vec);
  });

  it("honors a custom k", () => {
    const fused = reciprocalRankFusion(["a"], [], 10);

    expect(fused.get("a")?.fused).toBeCloseTo(1 / 11, 9);
  });

  it("returns an empty map for two empty lists", () => {
    expect(reciprocalRankFusion([], []).size).toBe(0);
  });
});

describe("matchReasonFor", () => {
  it("maps membership flags to a reason", () => {
    expect(matchReasonFor({ inKeyword: true, inVector: true })).toBe("both");
    expect(matchReasonFor({ inKeyword: false, inVector: true })).toBe("vector");
    expect(matchReasonFor({ inKeyword: true, inVector: false })).toBe("keyword");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/lib/rrf.test.ts
```

Expected: FAIL — `Failed to resolve import "./rrf"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/rrf.ts`:

```ts
/**
 * Reciprocal Rank Fusion over two ranked id lists. Rank-based, so the wildly
 * different score ranges of BM25 and cosine never need normalizing.
 */

export const DEFAULT_RRF_K = 60;

export type RrfEntry = {
  fused: number;
  inKeyword: boolean;
  inVector: boolean;
};

export type MatchReason = "keyword" | "vector" | "both";

export function reciprocalRankFusion(
  keywordRanking: readonly string[],
  vectorRanking: readonly string[],
  k: number = DEFAULT_RRF_K,
): Map<string, RrfEntry> {
  const result = new Map<string, RrfEntry>();

  const accumulate = (ranking: readonly string[], arm: "keyword" | "vector"): void => {
    ranking.forEach((id, rankIndex) => {
      const rank = rankIndex + 1; // 1-based: the top result is rank 1
      const entry = result.get(id) ?? { fused: 0, inKeyword: false, inVector: false };

      entry.fused += 1 / (k + rank);
      if (arm === "keyword") {
        entry.inKeyword = true;
      } else {
        entry.inVector = true;
      }

      result.set(id, entry);
    });
  };

  accumulate(keywordRanking, "keyword");
  accumulate(vectorRanking, "vector");

  return result;
}

export function matchReasonFor(entry: { inKeyword: boolean; inVector: boolean }): MatchReason {
  if (entry.inKeyword && entry.inVector) {
    return "both";
  }

  if (entry.inVector) {
    return "vector";
  }

  return "keyword";
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test src/lib/rrf.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rrf.ts src/lib/rrf.test.ts
git commit -m "feat: add reciprocal rank fusion"
```

---

## Task 5: CJK-aware tokenizer

**Files:**

- Modify: `src/lib/bm25.ts` (only the `tokenize` function and a new private helper)
- Modify: `src/lib/bm25.test.ts` (add CJK cases; keep existing cases green)

The M4 tokenizer (`split(/[^a-z0-9]+/)`) drops CJK text entirely. M5 makes `tokenize` script-aware by scanning the lowercased string into maximal runs: a non-CJK run tokenizes exactly as before (so all existing Latin/stopword/digit behavior is preserved bit-for-bit), and a CJK run emits character bigrams (`自动扩缩` → `自动`, `动扩`, `扩缩`; a lone CJK char emits itself). `bm25Search` is untouched — it already calls `tokenize` for both query and documents, so CJK support flows through symmetrically.

- [ ] **Step 1: Write the failing tests**

Append these cases to `src/lib/bm25.test.ts`. If the file does not already import `tokenize`, add it to the existing import from `./bm25`. Add a new `describe` block:

```ts
import { tokenize } from "./bm25";

describe("tokenize — CJK support", () => {
  it("emits character bigrams for a Han run", () => {
    expect(tokenize("自动扩缩")).toEqual(["自动", "动扩", "扩缩"]);
  });

  it("emits a unigram for a single CJK character", () => {
    expect(tokenize("水")).toEqual(["水"]);
  });

  it("tokenizes mixed Latin + CJK text", () => {
    expect(tokenize("React 服务端渲染")).toEqual(["react", "服务", "务端", "端渲", "渲染"]);
  });

  it("supports Hiragana, Katakana, and Hangul runs", () => {
    expect(tokenize("ひらがな")).toEqual(["ひら", "らが", "がな"]);
    expect(tokenize("カタカナ")).toEqual(["カタ", "タカ", "カナ"]);
    expect(tokenize("한국어")).toEqual(["한국", "국어"]);
  });

  it("preserves M4 Latin/stopword behavior", () => {
    expect(tokenize("The quick brown fox")).toEqual(["quick", "brown", "fox"]);
    expect(tokenize("React 18 hooks")).toEqual(["react", "18", "hooks"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

```bash
pnpm test src/lib/bm25.test.ts
```

Expected: the existing Latin tests PASS; the new CJK tests FAIL (e.g. `tokenize("自动扩缩")` currently returns `[]` because the regex split drops all CJK).

- [ ] **Step 3: Rewrite `tokenize` to be script-aware**

In `src/lib/bm25.ts`, replace the existing `tokenize` function (lines 29–34) with the following, and add the `cjkBigrams` helper and `CJK_CHAR` constant just above it:

```ts
// BMP Unicode ranges for scripts written without spaces: Hiragana/Katakana
// (U+3040–30FF), CJK Ext-A (U+3400–4DBF), CJK Unified (U+4E00–9FFF), Hangul
// syllables (U+AC00–D7AF). Bigram tokenization gives these a useful keyword arm.
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

function cjkBigrams(run: string): string[] {
  const chars = Array.from(run);

  if (chars.length === 1) {
    return [chars[0]];
  }

  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    bigrams.push(chars[i] + chars[i + 1]);
  }

  return bigrams;
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let i = 0;

  while (i < lower.length) {
    if (CJK_CHAR.test(lower[i])) {
      let j = i;
      while (j < lower.length && CJK_CHAR.test(lower[j])) {
        j += 1;
      }
      tokens.push(...cjkBigrams(lower.slice(i, j)));
      i = j;
    } else {
      let j = i;
      while (j < lower.length && !CJK_CHAR.test(lower[j])) {
        j += 1;
      }
      for (const token of lower.slice(i, j).split(/[^a-z0-9]+/)) {
        if (token.length > 0 && !STOPWORDS.has(token)) {
          tokens.push(token);
        }
      }
      i = j;
    }
  }

  return tokens;
}
```

> Note: `CJK_CHAR` has no `g` flag, so `.test()` is stateless and safe to call in the loop. The listed ranges are all in the Basic Multilingual Plane, so indexing `lower[i]` by UTF-16 code unit is correct; `cjkBigrams` uses `Array.from` for defensive code-point handling.

- [ ] **Step 4: Run the full bm25 suite to verify everything passes**

```bash
pnpm test src/lib/bm25.test.ts
```

Expected: PASS — both the new CJK cases and all pre-existing `tokenize`/`bm25Search` cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bm25.ts src/lib/bm25.test.ts
git commit -m "feat: make bm25 tokenizer CJK-aware via character bigrams"
```

---

## Task 6: Final M5a verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, including the four new/modified suites (`tokenChunking`, `vector`, `rrf`, `bm25`).

- [ ] **Step 2: Typecheck and lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS, no errors.

- [ ] **Step 3: Build and eyeball the worker bundle size (js-tiktoken risk)**

```bash
pnpm build
ls -lh dist/service-worker-loader.js dist/assets/*.js 2>/dev/null | sort -k5 -h | tail -5
```

Expected: build succeeds. `js-tiktoken` is imported by `tokenChunking.ts` but no application code imports `tokenChunking` yet, so the encoder rank data may be tree-shaken out of this build entirely — that is fine. Record the largest worker chunk size as a baseline. The parent spec (§10) flags `js-tiktoken`'s rank data as a bundle-size risk that becomes real in **M5b**, when `processPage` first imports `chunkTokens`. If the worker bundle grows materially there, M5b's open-questions note covers lazy-loading via dynamic `import()`.

- [ ] **Step 4: Confirm no application wiring changed**

```bash
git diff --stat main..HEAD
```

Expected: changed files are limited to `package.json`, `pnpm-lock.yaml`, the four `src/lib/` modules and their tests, and this plan file. No changes to `src/worker/`, `src/sidepanel/`, `src/options/`, `src/shared/`, or `manifest.config.ts` — those belong to M5b–M5d.

- [ ] **Step 5: Final commit (if anything is left unstaged)**

```bash
git status --short
```

Expected: clean. If not, stage and commit any stragglers with an appropriate `feat:`/`build:` message.

---

## Self-Review Notes

- **Spec coverage.** M5a delivers the four pure modules the parent spec lists under "New files" (§8) minus `MockLLMProvider` (an M5b test fixture): `lib/vector.ts` (§6.2), `lib/rrf.ts` (§6.3), `lib/tokenChunking.ts`, and the CJK tokenizer extension to `lib/bm25.ts` (§6.4). The unit-test bullets in §9 ("Unit") for these four modules are all implemented here.
- **Why pure-first.** Every module is side-effect-free, so this plan needs no `fake-indexeddb`, no mocked `fetch`, no Chrome shims — the fastest, most reliable tests in the milestone. It also front-loads the only new dependency (`js-tiktoken`) so its bundle-size impact is visible before M5b wires it into the worker.
- **`vector.ts` decoupled from `ChunkRecord`.** `cosineTopK` is generic over `{ embedding?: Float32Array }` rather than importing `ChunkRecord`. This keeps the module pure and lets M5a land before M5b adds the `embedding` field to `ChunkRecord` — no forward type dependency, build stays green. M5c will instantiate it with real `ChunkRecord[]`, which structurally satisfies the constraint.
- **CJK tokenizer is symmetric and self-wiring.** Because `bm25Search` already calls `tokenize` for both query and document text, making `tokenize` CJK-aware gives the keyword arm bigram-vs-bigram matching for Chinese/Japanese/Korean with zero changes to the scorer or to `RetrievalService`. Cross-lingual recall (Chinese query → English chunk) is **not** this tokenizer's job — that is carried by the multilingual embedding in the vector arm (M5c). Bigrams just stop CJK text from being dead weight in the keyword arm (parent spec §6.4).
- **`tokenCount` is the source-slice length.** It is the exact length of the original token window, not a re-encode of the decoded chunk text. BPE can merge differently across a decode→encode round-trip at window boundaries, so re-encoding would be both slower and slightly wrong; the slice length is exact and is what the detail view / M6 stats want.
- **Type/behavioral consistency with later plans.** `TokenChunk` (`{ text, tokenCount }`) is the shape M5b's `processPage` consumes to populate `ChunkRecord.text`/`tokenCount`. `VectorHit`/`EmbeddedItem` (`vector.ts`) and `RrfEntry`/`MatchReason`/`matchReasonFor` (`rrf.ts`) are the shapes M5c's `RetrievalService` consumes. `MatchReason` here (`"keyword" | "vector" | "both"`) matches the widened `SearchMatchReason` M5b/M5c put in `src/shared/types.ts`.
- **No runtime behavior change.** The only observable difference after M5a is that CJK chunk/query text now tokenizes into bigrams inside the existing keyword search. Since no CJK pages are likely saved yet and no new chunk/vector/RRF code path is wired, the running extension behaves as it did at M4.
