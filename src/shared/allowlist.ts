/**
 * v0.1.0 auto-save allowlist of technical/documentation domains.
 * A URL must match at least one pattern before a dwell timer is started.
 */
export const ALLOWLIST_PATTERNS: RegExp[] = [
  /^https?:\/\/(www\.)?github\.com/,
  /^https?:\/\/(www\.)?stackoverflow\.com/,
  /^https?:\/\/(www\.)?developer\.mozilla\.org/,
  /^https?:\/\/docs\./,
  /^https?:\/\/.*\.readthedocs\.io/,
  /^https?:\/\/(www\.)?npmjs\.com/,
  /^https?:\/\/(www\.)?rust-lang\.org/,
  /^https?:\/\/(www\.)?python\.org/,
];

/** Human-readable allowlist, rendered in Options. Keep in sync with the patterns. */
export const ALLOWLIST_DISPLAY: string[] = [
  "github.com",
  "stackoverflow.com",
  "developer.mozilla.org",
  "docs.* (any docs. subdomain)",
  "*.readthedocs.io",
  "npmjs.com",
  "rust-lang.org",
  "python.org",
];

export function isAllowlisted(url: string): boolean {
  return ALLOWLIST_PATTERNS.some((pattern) => pattern.test(url));
}
