import { stem } from "./stem";

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

  if (termSet.size === 0) {
    return escapeHtml(text);
  }

  const ranges: Array<{ start: number; end: number }> = [];
  const latinWord = /\b([a-z0-9]+)\b/gi;
  for (const match of text.matchAll(latinWord)) {
    const word = match[0];
    const start = match.index;
    const lower = word.toLowerCase();
    if (termSet.has(lower) || termSet.has(stem(lower))) {
      ranges.push({ start, end: start + word.length });
    }
  }

  // CJK queries are tokenized into overlapping bigrams. Record every matched
  // span against the original text, then merge overlaps so a multi-character
  // query produces valid, contiguous <mark> markup.
  const cjkTerm = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
  for (const term of termSet) {
    if (!cjkTerm.test(term)) continue;
    let start = text.indexOf(term);
    while (start !== -1) {
      ranges.push({ start, end: start + term.length });
      start = text.indexOf(term, start + 1);
    }
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
