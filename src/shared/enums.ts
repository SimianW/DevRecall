/**
 * Platform and ContentType enums.
 *
 * These replace the single `SourceType` string union: a saved page now gets an
 * independent platform (where it lives) and content type (what it is). Values
 * are lowercase strings so records remain JSON-serializable and readable in
 * IndexedDB, matching the existing `sourceType` vocabulary.
 */
export enum Platform {
  Github = "github",
  StackOverflow = "stackoverflow",
  Mdn = "mdn",
  Npm = "npm",
  ReadTheDocs = "readthedocs",
  Rust = "rust",
  Python = "python",
  Web = "web",
}

export enum ContentType {
  Documentation = "documentation",
  Issue = "issue",
  PullRequest = "pull_request",
  Repository = "repository",
  Question = "question",
  Article = "article",
  Paper = "paper",
  Course = "course",
  Package = "package",
  Page = "page",
}

/** Every Platform value, for iteration and UI filter rendering. */
export const PLATFORM_VALUES: readonly Platform[] = Object.values(Platform);

/** Every ContentType value, for iteration and UI filter rendering. */
export const CONTENT_TYPE_VALUES: readonly ContentType[] = Object.values(ContentType);

/** Type guard: true when `value` is a valid Platform (e.g. validating LLM tagging output). */
export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && PLATFORM_VALUES.includes(value as Platform);
}

/** Type guard: true when `value` is a valid ContentType (e.g. validating LLM tagging output). */
export function isContentType(value: unknown): value is ContentType {
  return typeof value === "string" && CONTENT_TYPE_VALUES.includes(value as ContentType);
}
