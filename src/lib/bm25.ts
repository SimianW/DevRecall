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
