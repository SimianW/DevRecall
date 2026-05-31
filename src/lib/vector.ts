export function normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) {
    sumSquares += vector[i] * vector[i];
  }

  const result = new Float32Array(vector.length);
  const magnitude = Math.sqrt(sumSquares);

  if (magnitude === 0) {
    return result;
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
