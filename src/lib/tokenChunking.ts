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

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = getEncoding("cl100k_base");
  }
  return encoder;
}

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
