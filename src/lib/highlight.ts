import { tokenizeWithSpans } from "./bm25";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes the text, then wraps whole-word occurrences of matched terms in
 * <mark>. Terms come from the BM25 tokenizer and are already stemmed. A word
 * in the text is highlighted when its Porter stem matches one of the given
 * stems (stem-aware matching keeps original surface forms visible).
 *
 * The returned HTML is safe to render.
 */
export function highlightTerms(text: string, terms: string[]): string {
  // Terms from the BM25 tokenizer are already stems (e.g. "autoscal" from
  // "autoscaler"). Store them as-is so we can match a text word either by
  // exact lowercase equality or by stemming the text word and checking its
  // stem against the set.
  const termSet = new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean));
  for (const term of terms) {
    for (const { token } of tokenizeWithSpans(term)) termSet.add(token);
  }

  if (termSet.size === 0) {
    return escapeHtml(text);
  }

  // Use the same token boundaries and stemming as BM25. In particular this
  // keeps C++/C#, camelCase parts, accented words, and CJK bigrams consistent
  // between ranking and evidence shown to the reader.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const span of tokenizeWithSpans(text)) {
    if (termSet.has(span.token)) ranges.push({ start: span.start, end: span.end });
  }

  if (ranges.length === 0) {
    return escapeHtml(text);
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  let cursor = 0;
  let highlighted = "";
  for (const range of merged) {
    highlighted += escapeHtml(text.slice(cursor, range.start));
    highlighted += `<mark>${escapeHtml(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  highlighted += escapeHtml(text.slice(cursor));
  return highlighted;
}
