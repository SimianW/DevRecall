/**
 * Excerpt derivation for page list views.
 *
 * Excerpts are derived from `fullText` at query time and never persisted:
 * capture/chunking may change, and a bounded preview is cheap to recompute.
 */

/** Hard cap on excerpt length, in characters. */
export const EXCERPT_MAX_CHARS = 240;

/**
 * Smallest word-boundary cut worth taking. Below this, a hard cut at the cap
 * reads better than a stub excerpt (e.g. a few short words followed by one
 * giant unbroken token such as a minified blob or a very long URL).
 */
const MIN_BOUNDARY_CHARS = Math.floor(EXCERPT_MAX_CHARS / 2);

/**
 * Whitespace-normalized excerpt of `fullText`, at most `EXCERPT_MAX_CHARS` long.
 *
 * - Collapses every whitespace run (spaces, newlines, tabs) to a single space
 *   and trims both ends.
 * - Text at or under the cap is returned as-is (after normalization).
 * - Over-cap text is cut at the last space within the cap when that cut leaves
 *   at least `MIN_BOUNDARY_CHARS`; text with no usable boundary (long unbroken
 *   tokens) is hard-cut at the cap.
 */
export function deriveExcerpt(fullText: string): string {
  const normalized = fullText.replace(/\s+/g, " ").trim();
  if (normalized.length <= EXCERPT_MAX_CHARS) {
    return normalized;
  }

  // Search one char past the cap: a boundary exactly at index 240 still yields
  // a full-length excerpt that ends on a whole word.
  const head = normalized.slice(0, EXCERPT_MAX_CHARS + 1);
  const lastSpace = head.lastIndexOf(" ");

  return lastSpace >= MIN_BOUNDARY_CHARS
    ? head.slice(0, lastSpace)
    : normalized.slice(0, EXCERPT_MAX_CHARS);
}
