import { stem } from "./stem";

const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

// BMP Unicode ranges for scripts written without spaces: Hiragana/Katakana
// (U+3040–30FF), CJK Ext-A (U+3400–4DBF), CJK Unified (U+4E00–9FFF), Hangul
// syllables (U+AC00–D7AF). Bigram tokenization gives these a useful keyword arm.
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const WORD_TOKEN = /C\+\+|C#|[\p{L}\p{N}]+/giu;

export type TokenSpan = {
  token: string;
  start: number;
  end: number;
};

function normalizedToken(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (STOPWORDS.has(lower)) return null;
  return /^[a-z0-9]+$/.test(lower) ? stem(lower) : lower;
}

function camelCaseParts(raw: string): Array<{ text: string; offset: number }> {
  if (!/^[A-Za-z0-9]+$/.test(raw) || !/[a-z]/.test(raw) || !/[A-Z]/.test(raw)) return [];
  const parts: Array<{ text: string; offset: number }> = [];
  const pattern = /[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g;
  for (const match of raw.matchAll(pattern)) {
    parts.push({ text: match[0], offset: match.index ?? 0 });
  }
  return parts.length > 1 ? parts : [];
}

/** Tokenize text and retain source ranges so highlighting uses identical rules. */
export function tokenizeWithSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let i = 0;

  // Walk the original string: Unicode lowercasing can change its length.
  while (i < text.length) {
    if (CJK_CHAR.test(text[i])) {
      let j = i;
      while (j < text.length && CJK_CHAR.test(text[j])) {
        j += 1;
      }
      // These CJK ranges are all single UTF-16 code units. Advancing a
      // position keeps long unspaced articles linear in their text length.
      const width = j - i === 1 ? 1 : 2;
      for (let start = i; start + width <= j; start += 1) {
        spans.push({ token: text.slice(start, start + width), start, end: start + width });
      }
      i = j;
    } else {
      let j = i;
      while (j < text.length && !CJK_CHAR.test(text[j])) {
        j += 1;
      }
      const run = text.slice(i, j);
      for (const match of run.matchAll(WORD_TOKEN)) {
        const raw = match[0];
        const start = i + (match.index ?? 0);
        const token = normalizedToken(raw);
        if (token !== null) {
          spans.push({ token, start, end: start + raw.length });
        }
        for (const part of camelCaseParts(raw)) {
          const partToken = normalizedToken(part.text);
          if (partToken !== null) {
            const partStart = start + part.offset;
            spans.push({ token: partToken, start: partStart, end: partStart + part.text.length });
          }
        }
      }
      i = j;
    }
  }

  return spans;
}

export function tokenize(text: string): string[] {
  return tokenizeWithSpans(text).map(({ token }) => token);
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

type IndexedDocument = {
  termCounts: Map<string, number>;
  length: number;
};

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;
const DEFAULT_TOP_K = 50;

/**
 * A BM25 index over one fixed corpus. Tokenization, term frequencies, document
 * lengths, and document frequencies are computed once when the index is built.
 * Callers can then run many queries without rescanning every document.
 */
export class Bm25Index {
  private readonly documents: IndexedDocument[];
  private readonly averageDocumentLength: number;
  private readonly documentFrequency: Map<string, number>;
  private readonly k1: number;
  private readonly b: number;

  constructor(documents: string[], options: Pick<Bm25Options, "k1" | "b"> = {}) {
    this.k1 = options.k1 ?? DEFAULT_K1;
    this.b = options.b ?? DEFAULT_B;
    this.documents = documents.map((document) => {
      const termCounts = new Map<string, number>();
      for (const token of tokenize(document)) {
        termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
      }
      return {
        termCounts,
        length: Array.from(termCounts.values()).reduce((sum, count) => sum + count, 0),
      };
    });

    const totalLength = this.documents.reduce((sum, document) => sum + document.length, 0);
    this.averageDocumentLength = totalLength / this.documents.length || 1;
    this.documentFrequency = new Map();
    for (const document of this.documents) {
      for (const term of document.termCounts.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  search(query: string, options: Pick<Bm25Options, "topK"> = {}): Bm25Hit[] {
    const queryTerms = Array.from(new Set(tokenize(query)));
    const topK = options.topK ?? DEFAULT_TOP_K;

    if (queryTerms.length === 0 || this.documents.length === 0 || topK <= 0) {
      return [];
    }

    const hits: Bm25Hit[] = [];
    for (let index = 0; index < this.documents.length; index += 1) {
      const document = this.documents[index];
      let score = 0;
      const matchedTerms: string[] = [];

      for (const term of queryTerms) {
        const tf = document.termCounts.get(term) ?? 0;
        if (tf === 0) continue;

        const df = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (this.documents.length - df + 0.5) / (df + 0.5));
        const denominator =
          tf + this.k1 * (1 - this.b + (this.b * document.length) / this.averageDocumentLength);
        score += idf * ((tf * (this.k1 + 1)) / denominator);
        matchedTerms.push(term);
      }

      if (score > 0) hits.push({ index, score, matchedTerms });
    }

    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, topK);
  }
}

/** Compatibility helper for one-off searches. */
export function bm25Search(
  query: string,
  documents: string[],
  options: Bm25Options = {},
): Bm25Hit[] {
  return new Bm25Index(documents, options).search(query, options);
}
