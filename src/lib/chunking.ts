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
