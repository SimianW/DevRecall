import { normalize } from "../../lib/vector";
import type { TaggingResult } from "../../shared/types";
import type { Embedder, PageTagger } from "./OpenAIProvider";

const EMBEDDING_DIM = 1536;

/**
 * Deterministic, network-free tagger + embedder for integration tests. The
 * embedding is a hash-seeded pseudo-random unit vector: stable per input,
 * distinct across inputs. It carries no semantics — tests that assert ranking
 * by meaning supply their own controlled vectors (see M5c).
 */
export class MockLLMProvider implements PageTagger, Embedder {
  readonly embeddingModel = "mock:embedding";

  async summarizeAndTag(
    _fullText: string,
    title: string,
    _url: string,
    _apiKey: string,
  ): Promise<TaggingResult> {
    return {
      summary: `Mock summary of "${title}".`,
      sourceType: "official_docs",
      topics: ["mock"],
      technologies: [],
      intent: "reference",
    };
  }

  async embed(text: string, _apiKey: string): Promise<Float32Array> {
    return hashEmbedding(text);
  }

  async embedBatch(texts: string[], _apiKey: string): Promise<Float32Array[]> {
    return texts.map((text) => hashEmbedding(text));
  }
}

function hashEmbedding(text: string): Float32Array {
  // FNV-1a hash of the text seeds a mulberry32 PRNG; fill then L2-normalize.
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  let state = seed >>> 0;
  const vector = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    vector[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  }

  return normalize(vector);
}
