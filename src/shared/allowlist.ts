/**
 * v0.1.0 auto-save allowlist of technical/documentation domains.
 * A URL must match at least one rule before a dwell timer is started.
 *
 * Rules see only the URL's hostname, so lookalike hosts (github.com.evil.example)
 * and allowlisted names in a path or query string never match.
 */
type AllowlistRule = {
  /** Rendered in Options. Lives beside `matches` so the two stay in sync. */
  display: string;
  matches(host: string): boolean;
};

/**
 * docs.* hosts that serve private user documents rather than public reference
 * material. Auto-saving them would store, and in Hybrid mode send to OpenAI,
 * documents the user never chose to keep.
 */
export const PRIVATE_DOCS_HOSTS: string[] = ["docs.google.com", "docs.qq.com", "docs.zoho.com"];

/** The domain itself or its www. host. */
function site(domain: string): AllowlistRule {
  return { display: domain, matches: (host) => host === domain || host === `www.${domain}` };
}

const ALLOWLIST_RULES: AllowlistRule[] = [
  site("github.com"),
  site("stackoverflow.com"),
  site("developer.mozilla.org"),
  {
    display: `docs.* (any docs. subdomain except ${PRIVATE_DOCS_HOSTS.join(", ")})`,
    matches: (host) =>
      host.startsWith("docs.") &&
      host.length > "docs.".length &&
      !PRIVATE_DOCS_HOSTS.includes(host),
  },
  { display: "*.readthedocs.io", matches: (host) => host.endsWith(".readthedocs.io") },
  site("npmjs.com"),
  site("rust-lang.org"),
  site("python.org"),
];

/** Human-readable allowlist, rendered in Options. */
export const ALLOWLIST_DISPLAY: string[] = ALLOWLIST_RULES.map((rule) => rule.display);

export function isAllowlisted(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  // URL lowercases and punycodes the host; drop a trailing root dot so
  // docs.google.com. cannot slip past the private-host exclusion.
  const host = parsed.hostname.replace(/\.$/, "");
  return ALLOWLIST_RULES.some((rule) => rule.matches(host));
}
