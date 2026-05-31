export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes the text, then wraps whole-word occurrences of the given terms in
 * <mark>. Terms come from the BM25 tokenizer, so they are alphanumeric and
 * survive escaping unchanged. The returned HTML is safe to render.
 */
export function highlightTerms(text: string, terms: string[]): string {
  const escaped = escapeHtml(text);

  const unique = Array.from(
    new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean)),
  );

  if (unique.length === 0) {
    return escaped;
  }

  const pattern = unique
    .sort((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  const regex = new RegExp(`\\b(${pattern})\\b`, "gi");

  return escaped.replace(regex, "<mark>$1</mark>");
}
