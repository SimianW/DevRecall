/** The search mode the user chooses and the app persists. */
export type StoredMode = "local" | "hybrid";

/** The configured mode after accounting for current API-key availability. */
export type EffectiveMode = "local" | "hybrid";

/** How one completed search actually ran. This value is never persisted. */
export type SearchMode = EffectiveMode | "keyword_fallback";
