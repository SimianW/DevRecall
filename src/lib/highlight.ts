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
  const escaped = escapeHtml(text);

  // Terms from the BM25 tokenizer are already stems (e.g. "autoscal" from
  // "autoscaler"). Store them as-is so we can match a text word either by
  // exact lowercase equality or by stemming the text word and checking its
  // stem against the set.
  const termSet = new Set(
    terms.map((term) => term.trim().toLowerCase()).filter(Boolean),
  );

  if (termSet.size === 0) {
    return escaped;
  }

  // Replace every alphanumeric word run with itself wrapped in <mark> when the
  // text word matches a term either by exact lowercase equality (for raw terms)
  // or by stemming the text word and checking against the term set (for when
  // terms are already Porter stems, as emitted by the BM25 tokenizer).
  return escaped.replace(/\b([a-z0-9]+)\b/gi, (match) => {
    const lower = match.toLowerCase();
    if (termSet.has(lower) || termSet.has(stem(lower))) {
      return `<mark>${match}</mark>`;
    }
    return match;
  });
}
