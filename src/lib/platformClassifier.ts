import { ContentType, Platform } from "../shared/enums";

/**
 * Local URL classifier: maps a saved page's URL + domain to a
 * {@link Platform} (where the content lives) and a {@link ContentType}
 * (what the content is). Pure and synchronous — no network, no DB — so it
 * can run at capture time before LLM enrichment, giving every record a
 * usable filter value immediately (LLM tagging may refine it later).
 */

export type PageClassification = {
  platform: Platform;
  contentType: ContentType;
};

/** Ordered host → documentation-platform rules. Exact host or any subdomain. */
const DOCUMENTATION_HOSTS: ReadonlyArray<readonly [base: string, platform: Platform]> = [
  ["developer.mozilla.org", Platform.Mdn],
  ["readthedocs.io", Platform.ReadTheDocs],
  ["readthedocs.org", Platform.ReadTheDocs],
  ["docs.python.org", Platform.Python],
  ["doc.rust-lang.org", Platform.Rust],
];

/**
 * Official documentation sites with no dedicated Platform value in the enum.
 * They classify as `web` platform + `documentation` content type.
 */
const WEB_DOCUMENTATION_HOSTS: readonly string[] = [
  "kubernetes.io",
  "react.dev",
  "nodejs.org",
  "typescriptlang.org",
];

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function matchesHost(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/** Non-empty, decoded path segments: "/owner/repo/issues/12" → ["owner", "repo", "issues", "12"]. */
function pathSegments(url: URL | null): string[] {
  if (!url) return [];
  return url.pathname.split("/").filter((segment) => segment.length > 0);
}

const GITHUB_NON_REPOSITORY_PREFIXES: ReadonlySet<string> = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "topics",
  "trending",
  "users",
]);

function classifyGitHub(host: string, segments: string[]): PageClassification {
  const isMainHost = host === "github.com" || host === "www.github.com";
  if (!isMainHost) {
    return { platform: Platform.Github, contentType: ContentType.Page };
  }

  const isRepositoryPath =
    segments.length >= 2 && !GITHUB_NON_REPOSITORY_PREFIXES.has(segments[0].toLowerCase());
  if (!isRepositoryPath) {
    return { platform: Platform.Github, contentType: ContentType.Page };
  }

  if (segments[2] === "issues") {
    return { platform: Platform.Github, contentType: ContentType.Issue };
  }
  if (segments[2] === "pull" && segments.length >= 4) {
    return { platform: Platform.Github, contentType: ContentType.PullRequest };
  }
  if (segments.length === 2) {
    return { platform: Platform.Github, contentType: ContentType.Repository };
  }

  return { platform: Platform.Github, contentType: ContentType.Page };
}

/**
 * Classify a page from its URL and domain.
 *
 * Domain matching is exact-host or any-subdomain (`www.npmjs.com` matches
 * `npmjs.com`). When `domain` is empty or the URL cannot be parsed, the
 * function still returns — it never throws, falling back to whatever host
 * information is available and ultimately to `{ web, page }`.
 */
export function classifyPage(url: string, domain: string): PageClassification {
  const parsed = parseUrl(url);
  const host = (domain || parsed?.hostname || "").toLowerCase();
  const segments = pathSegments(parsed);

  if (matchesHost(host, "github.com")) {
    return classifyGitHub(host, segments);
  }

  if (matchesHost(host, "stackoverflow.com")) {
    if (segments[0] === "questions") {
      return { platform: Platform.StackOverflow, contentType: ContentType.Question };
    }
    return { platform: Platform.StackOverflow, contentType: ContentType.Page };
  }

  if (matchesHost(host, "npmjs.com")) {
    if (segments[0] === "package") {
      return { platform: Platform.Npm, contentType: ContentType.Package };
    }
    return { platform: Platform.Npm, contentType: ContentType.Page };
  }

  for (const [base, platform] of DOCUMENTATION_HOSTS) {
    if (matchesHost(host, base)) {
      return { platform, contentType: ContentType.Documentation };
    }
  }

  for (const base of WEB_DOCUMENTATION_HOSTS) {
    if (matchesHost(host, base)) {
      return { platform: Platform.Web, contentType: ContentType.Documentation };
    }
  }

  return { platform: Platform.Web, contentType: ContentType.Page };
}
