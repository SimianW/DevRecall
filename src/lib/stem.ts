/**
 * Minimal English Porter stemmer (Step 1a, 1b, 1c, 2, 3, 4, 5a, 5b).
 *
 * Pure TypeScript, zero dependencies, ~2 KB minified.
 * Only applied to Latin/ASCII tokens in the BM25 tokeniser.
 *
 * Reference: https://tartarus.org/martin/PorterStemmer/
 */

/** True if the character at position i in w is a consonant. */
function isConsonantAt(w: string, i: number): boolean {
  const ch = w[i];
  if (ch === "a" || ch === "e" || ch === "i" || ch === "o" || ch === "u") {
    return false;
  }
  if (ch === "y") {
    return i === 0 || !isConsonantAt(w, i - 1);
  }
  return true;
}

/**
 * Measure m: count of VC sequences in w[0..j].
 * m > 0  ↔  there is at least one VC pair before position j+1.
 */
function measure(w: string, j: number): number {
  let n = 0;
  let i = 0;
  while (true) {
    if (i > j) return n;
    if (!isConsonantAt(w, i)) break;
    i += 1;
  }
  i += 1;
  while (true) {
    while (true) {
      if (i > j) return n;
      if (isConsonantAt(w, i)) break;
      i += 1;
    }
    i += 1;
    n += 1;
    while (true) {
      if (i > j) return n;
      if (!isConsonantAt(w, i)) break;
      i += 1;
    }
    i += 1;
  }
}

/** True if w[0..j] contains a vowel. */
function containsVowel(w: string, j: number): boolean {
  for (let i = 0; i <= j; i += 1) {
    if (!isConsonantAt(w, i)) return true;
  }
  return false;
}

/** True if w[j-1..j] is a double consonant (e.g. "bb", "tt"). */
function endsDoubleConsonant(w: string, j: number): boolean {
  if (j < 1) return false;
  if (w[j] !== w[j - 1]) return false;
  return isConsonantAt(w, j);
}

/**
 * True if w[j-2..j] has the pattern CVC where the final consonant is not
 * w, x, or y.
 */
function endsCvc(w: string, j: number): boolean {
  if (j < 2) return false;
  if (!isConsonantAt(w, j) || isConsonantAt(w, j - 1) || !isConsonantAt(w, j - 2)) {
    return false;
  }
  const last = w[j];
  return last !== "w" && last !== "x" && last !== "y";
}

// ---------------------------------------------------------------------------
// Porter steps
// ---------------------------------------------------------------------------

/** Step 1a: plurals and -ed/-ing. */
function step1a(w: string): string {
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ies")) return w.slice(0, -2);
  if (w.endsWith("ss")) return w;
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** Step 1b: -eed, -ed, -ing. */
function step1b(w: string): string {
  if (w.endsWith("eed")) {
    const stem = w.slice(0, -3);
    if (measure(stem, stem.length - 1) > 0) return stem + "ee";
    return w;
  }

  let flag = false;
  let base = w;

  if (w.endsWith("ed")) {
    const stem = w.slice(0, -2);
    if (containsVowel(stem, stem.length - 1)) {
      base = stem;
      flag = true;
    }
  } else if (w.endsWith("ing")) {
    const stem = w.slice(0, -3);
    if (containsVowel(stem, stem.length - 1)) {
      base = stem;
      flag = true;
    }
  }

  if (!flag) return w;

  if (base.endsWith("at") || base.endsWith("bl") || base.endsWith("iz")) {
    return base + "e";
  }
  const j = base.length - 1;
  if (endsDoubleConsonant(base, j) && base[j] !== "l" && base[j] !== "s" && base[j] !== "z") {
    return base.slice(0, -1);
  }
  if (measure(base, j) === 1 && endsCvc(base, j)) {
    return base + "e";
  }
  return base;
}

/** Step 1c: y → i when there is a vowel in the stem. */
function step1c(w: string): string {
  if (w.endsWith("y") && w.length > 2 && containsVowel(w, w.length - 2)) {
    return w.slice(0, -1) + "i";
  }
  return w;
}

type Rule = [suffix: string, replacement: string];

function applyRules(w: string, rules: Rule[], minM: number): string {
  for (const [suffix, replacement] of rules) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, w.length - suffix.length);
      if (measure(stem, stem.length - 1) > minM - 1) {
        return stem + replacement;
      }
      return w;
    }
  }
  return w;
}

const STEP2_RULES: Rule[] = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["abli", "able"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
];

const STEP3_RULES: Rule[] = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
];

const STEP4_RULES: Rule[] = [
  ["al", ""],
  ["ance", ""],
  ["ence", ""],
  ["er", ""],
  ["ic", ""],
  ["able", ""],
  ["ible", ""],
  ["ant", ""],
  ["ement", ""],
  ["ment", ""],
  ["ent", ""],
  ["ism", ""],
  ["ate", ""],
  ["iti", ""],
  ["ous", ""],
  ["ive", ""],
  ["ize", ""],
];

/** Step 4: remove residual suffixes (requires m > 1). */
function step4(w: string): string {
  // Special case: "ion" only removed after s or t
  if (w.endsWith("ion")) {
    const stem = w.slice(0, -3);
    if (
      stem.length > 0 &&
      (stem[stem.length - 1] === "s" || stem[stem.length - 1] === "t") &&
      measure(stem, stem.length - 1) > 1
    ) {
      return stem;
    }
    return w;
  }
  return applyRules(w, STEP4_RULES, 2);
}

/** Step 5a: remove trailing e. */
function step5a(w: string): string {
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    const j = stem.length - 1;
    if (measure(stem, j) > 1) return stem;
    if (measure(stem, j) === 1 && !endsCvc(stem, j)) return stem;
  }
  return w;
}

/** Step 5b: double-l reduction. */
function step5b(w: string): string {
  const j = w.length - 1;
  if (measure(w, j) > 1 && endsDoubleConsonant(w, j) && w[j] === "l") {
    return w.slice(0, -1);
  }
  return w;
}

/**
 * Return the Porter stem of a lowercase ASCII word.
 * Words shorter than 3 characters are returned as-is to avoid mangling
 * short dev tokens like "js", "ts", "go".
 */
export function stem(word: string): string {
  if (word.length < 3) return word;

  let w = word;
  w = step1a(w);
  w = step1b(w);
  w = step1c(w);
  w = applyRules(w, STEP2_RULES, 1);
  w = applyRules(w, STEP3_RULES, 1);
  w = step4(w);
  w = step5a(w);
  w = step5b(w);
  return w;
}
