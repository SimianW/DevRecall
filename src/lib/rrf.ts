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
