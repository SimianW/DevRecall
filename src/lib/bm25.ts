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
          tokens.push(stem(token));
        }
      }
      i = j;
    }
  }

  return tokens;
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
