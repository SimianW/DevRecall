/**
 * Empirical measurement harness for MIN_VECTOR_SCORE (RetrievalService).
 *
 * NOT a unit test — it makes real OpenAI embedding calls. It is skipped unless
 * OPENAI_API_KEY is set, so it never runs in CI or in a normal `pnpm test`.
 *
 * Run it to see the actual cosine similarity of representative query/chunk
 * pairs against the live `text-embedding-3-small` model, then pick the vector
 * threshold just below the floor of the "good" synonym matches.
 *
 *   OPENAI_API_KEY=sk-... pnpm test src/lib/vectorThreshold.measure.test.ts
 *
 * Reuses OpenAIProvider.embedBatch so the model + L2 normalisation match
 * production exactly; cosine == dot product on the normalised vectors.
 */
import { describe, expect, it } from "vitest";

import { dot } from "./vector";
import { OpenAIProvider } from "../worker/llm/OpenAIProvider";

// Node's `process` — declared locally to avoid pulling @types/node into the build.
declare const process: { env: Record<string, string | undefined> };

const apiKey = process.env.OPENAI_API_KEY;

// Realistic chunk excerpts taken from the two pages under investigation.
const CHUNKS: Record<string, string> = {
  chromeSmall:
    "Chrome Releases Early Stable Update for Desktop. The Stable channel has been " +
    "updated to 149.0.7827.53/.54 for Windows and Mac as part of our early stable " +
    "release to a small percentage of users. A full list of changes in this build " +
    "is available in the log. Interested in switching release channels? Find out how.",
  onePagerReport:
    "Project & Performance: These one-pagers can help to highlight key information " +
    "and performance on a project, program, or service and can be helpful to share " +
    "information with stakeholders on scope of work, timelines, and plans for " +
    "achieving goals. They summarise business plans, strategy and key objectives.",
  onePagerTemplate:
    "Additional References: Readers may benefit from additional information so " +
    "providing hyperlinks or titles for further reading can be a good practice to " +
    "consider including in your one-pager. Conclusion / Call to Action: end with a " +
    "clear next step such as contacting the company or visiting a website.",
};

// Each probe: the query a user types, and which chunk it *should* recall.
const PROBES: Array<{ query: string; target: keyof typeof CHUNKS; note: string }> = [
  { query: "little", target: "chromeSmall", note: "pure synonym of 'small' (the reported miss)" },
  { query: "small", target: "chromeSmall", note: "exact word — high-end control" },
  { query: "tiny fraction of users", target: "chromeSmall", note: "natural-language paraphrase" },
  { query: "reporting", target: "onePagerReport", note: "morphological variant of 'report'" },
  { query: "report", target: "onePagerReport", note: "exact-ish word — control" },
  { query: "hyperlinks", target: "onePagerTemplate", note: "exact but peripheral (keyword-only)" },
  { query: "one-pager", target: "onePagerTemplate", note: "central topic — high-end control" },
];

const CURRENT_THRESHOLD = 0.4;

describe("MIN_VECTOR_SCORE measurement", () => {
  (apiKey ? it : it.skip)(
    "prints cosine of representative query/chunk pairs",
    async () => {
      const provider = new OpenAIProvider();

      const chunkKeys = Object.keys(CHUNKS);
      const chunkTexts = chunkKeys.map((k) => CHUNKS[k]);
      const queryTexts = PROBES.map((p) => p.query);

      const [chunkVecs, queryVecs] = await Promise.all([
        provider.embedBatch(chunkTexts, apiKey as string),
        provider.embedBatch(queryTexts, apiKey as string),
      ]);

      const chunkVecByKey = new Map(chunkKeys.map((k, i) => [k, chunkVecs[i]]));

      const lines: string[] = [];
      lines.push("");
      lines.push(`current MIN_VECTOR_SCORE = ${CURRENT_THRESHOLD}`);
      lines.push("");
      lines.push(
        "query".padEnd(24) +
          "target".padEnd(8) +
          "best".padEnd(8) +
          "pass?".padEnd(7) +
          "note",
      );
      lines.push("-".repeat(80));

      for (let i = 0; i < PROBES.length; i += 1) {
        const probe = PROBES[i];
        const qv = queryVecs[i];

        const targetScore = dot(qv, chunkVecByKey.get(probe.target)!);

        // Best cosine across ALL chunks (reveals false-positive risk vs distractors).
        let best = -Infinity;
        let bestKey = "";
        for (const key of chunkKeys) {
          const s = dot(qv, chunkVecByKey.get(key)!);
          if (s > best) {
            best = s;
            bestKey = key;
          }
        }

        const passes = targetScore >= CURRENT_THRESHOLD ? "yes" : "NO";
        lines.push(
          probe.query.padEnd(24) +
            targetScore.toFixed(3).padEnd(8) +
            `${best.toFixed(3)}${bestKey === probe.target ? "" : "*"}`.padEnd(8) +
            passes.padEnd(7) +
            probe.note,
        );
      }

      lines.push("-".repeat(80));
      lines.push("target = cosine vs the chunk it should recall");
      lines.push("best   = max cosine across all chunks (* = top chunk is NOT the target → false-positive risk)");
      lines.push("");

      console.log(lines.join("\n"));

      expect(chunkVecs).toHaveLength(chunkKeys.length);
    },
    60_000,
  );
});
