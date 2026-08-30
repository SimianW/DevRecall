import { useCallback, useEffect, useRef, useState } from "react";

import { ContentType, Platform } from "../shared/enums";
import type {
  DevRecallResponse,
  PageListItemWithExcerpt,
  WorkerBroadcast,
} from "../shared/messages";
import type { PageHit } from "../shared/types";
import type { EffectiveMode } from "../shared/modes";
import { PageCard, SearchResultCard, SurfaceShell } from "../ui/components";
import { sendRequest, subscribeToBroadcasts } from "../ui/rpc";
import { SaveBar } from "./SaveBar";

const filters = ["All", "Docs", "Stack Overflow", "GitHub"] as const;
type Filter = (typeof filters)[number];
type SearchResult = Extract<DevRecallResponse, { type: "search.results" }>["payload"];
type SearchMode = SearchResult["searchMode"];
type SearchStatus = Pick<
  Extract<DevRecallResponse, { type: "settings.status" }>["payload"],
  "hasApiKey" | "effectiveMode"
>;

const FIRST_RUN_DISMISSED_KEY = "devrecall.firstRunExplanationDismissed";

type AppProps = {
  listPages?: () => Promise<PageListItemWithExcerpt[]>;
  loadSearchStatus?: () => Promise<SearchStatus>;
  runSearch?: (query: string) => Promise<SearchResult>;
  addAiFeatures?: (id: string) => Promise<void>;
  deletePage?: (id: string) => Promise<void>;
  retryPage?: (id: string) => Promise<void>;
  openSettings?: () => void;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
};

async function defaultListPages(): Promise<PageListItemWithExcerpt[]> {
  const response = await sendRequest({ type: "page.list", payload: { limit: 50 } }, "page.listed");
  return response?.payload.pages ?? [];
}

async function defaultLoadSearchStatus(): Promise<SearchStatus> {
  const response = await sendRequest({ type: "settings.getStatus" }, "settings.status");
  return {
    hasApiKey: response?.payload.hasApiKey ?? false,
    effectiveMode: response?.payload.effectiveMode ?? "local",
  };
}

async function defaultRunSearch(query: string): Promise<SearchResult> {
  const response = await sendRequest({ type: "search.run", payload: { query } }, "search.results");
  return response?.payload ?? { results: [], searchMode: "local" };
}

async function defaultAddAiFeatures(id: string): Promise<void> {
  await sendRequest(
    { type: "page.addAiFeatures", payload: { pageId: id } },
    "page.aiFeaturesStarted",
  );
}

async function defaultDeletePage(id: string): Promise<void> {
  await sendRequest({ type: "page.delete", payload: { id } }, "page.deleted");
}

async function defaultRetryPage(id: string): Promise<void> {
  await sendRequest({ type: "page.retry", payload: { id } }, "page.retryStarted");
}

function defaultOpenSettings() {
  void chrome.runtime.openOptionsPage();
}

const defaultSubscribe = subscribeToBroadcasts;

function matchesFilter(page: PageHit["page"], filter: Filter) {
  switch (filter) {
    case "All":
      return true;
    case "Docs":
      return page.contentType === ContentType.Documentation;
    case "Stack Overflow":
      return page.platform === Platform.StackOverflow;
    case "GitHub":
      return page.platform === Platform.Github;
  }
}

function modeText(mode: SearchMode | null) {
  if (mode === "keyword_fallback") {
    return "Semantic search unavailable. Showing keyword results.";
  }
  if (mode === "hybrid") return "Hybrid";
  if (mode === "local") return "Local-only";
  return "Loading search mode...";
}

function wasFirstRunDismissed() {
  try {
    return localStorage.getItem(FIRST_RUN_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function App({
  listPages = defaultListPages,
  loadSearchStatus = defaultLoadSearchStatus,
  runSearch = defaultRunSearch,
  addAiFeatures = defaultAddAiFeatures,
  deletePage = defaultDeletePage,
  retryPage = defaultRetryPage,
  openSettings = defaultOpenSettings,
  subscribe = defaultSubscribe,
}: AppProps) {
  const [pages, setPages] = useState<PageListItemWithExcerpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hits, setHits] = useState<PageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<EffectiveMode>("local");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const [showFirstRun, setShowFirstRun] = useState(() => !wasFirstRunDismissed());
  const submittedQueryRef = useRef(submittedQuery);

  useEffect(() => {
    let cancelled = false;
    void loadSearchStatus()
      .then((status) => {
        if (!cancelled) {
          setHasApiKey(status.hasApiKey);
          setEffectiveMode(status.effectiveMode);
          setSearchMode(status.effectiveMode);
        }
      })
      .catch(() => {
        if (!cancelled) setSearchMode("local");
      });
    return () => {
      cancelled = true;
    };
  }, [loadSearchStatus]);

  useEffect(() => {
    let cancelled = false;

    async function loadPages() {
      setLoading(true);
      try {
        const nextPages = await listPages();
        if (!cancelled) {
          setPages(nextPages);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setPages([]);
          setLoading(false);
        }
      }
    }

    void loadPages();
    return () => {
      cancelled = true;
    };
  }, [listPages]);

  useEffect(() => {
    const handle = setTimeout(() => setSubmittedQuery(query.trim()), 200);
    return () => clearTimeout(handle);
  }, [query]);

  // Keep ref in sync so the broadcast handler can check if a search is active
  useEffect(() => {
    submittedQueryRef.current = submittedQuery;
  }, [submittedQuery]);

  useEffect(() => {
    if (submittedQuery.length === 0) {
      setHits([]);
      setSearchMode(effectiveMode);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    void runSearch(submittedQuery)
      .then((result) => {
        if (!cancelled) {
          setHits(result.results);
          setSearchMode(result.searchMode);
          setSearching(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHits([]);
          setSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveMode, submittedQuery, runSearch]);

  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === "page.updated") {
        setPages((previous) => {
          const index = previous.findIndex((page) => page.id === message.payload.page.id);
          const updated = {
            ...message.payload.page,
            excerpt: message.payload.page.excerpt ?? (index === -1 ? "" : previous[index].excerpt),
          };
          if (index === -1) return [updated, ...previous];
          const next = previous.slice();
          next[index] = updated;
          return next;
        });
      } else if (message.type === "page.removed") {
        setPages((previous) => previous.filter((page) => page.id !== message.payload.id));
      } else if (message.type === "library.cleared") {
        setPages([]);
        setQuery("");
        setSubmittedQuery("");
        setHits([]);
        setSearching(false);
      } else if (message.type === "settings.changed") {
        setHasApiKey(message.payload.hasApiKey);
        setEffectiveMode(message.payload.effectiveMode);
        // Only update searchMode when no query is active; completed results keep their actual mode
        if (submittedQueryRef.current.length === 0) {
          setSearchMode(message.payload.effectiveMode);
        }
      }
    });

    return unsubscribe;
  }, [subscribe]);

  const handleDelete = useCallback(
    (id: string) => {
      void deletePage(id);
    },
    [deletePage],
  );

  const handleRetry = useCallback(
    (id: string) => {
      void retryPage(id);
    },
    [retryPage],
  );

  const handleAddAiFeatures = useCallback(
    (id: string) => {
      void addAiFeatures(id);
    },
    [addAiFeatures],
  );

  const dismissFirstRun = () => {
    setShowFirstRun(false);
    try {
      localStorage.setItem(FIRST_RUN_DISMISSED_KEY, "true");
    } catch {
      // The explanation remains dismissed for this session even if storage is unavailable.
    }
  };

  const filteredPages = pages.filter((page) => matchesFilter(page, activeFilter));
  const filteredHits = hits.filter((hit) => matchesFilter(hit.page, activeFilter));
  const isSearching = submittedQuery.length > 0;

  return (
    <SurfaceShell
      title="DevRecall"
      actions={
        <button
          type="button"
          aria-label="Settings"
          className="rounded-md border border-default bg-surface-raised px-2 py-1 text-sm text-foreground/75 transition-colors hover:bg-foreground/5"
          onClick={openSettings}
        >
          Settings
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {showFirstRun && (
          <section className="rounded-md border border-accent/25 bg-accent/5 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Your library starts local</h2>
                <p className="mt-1 text-sm text-foreground/65">
                  Save and search pages without an API key. AI summaries and semantic search are
                  optional and can be set up in Settings.
                </p>
                <button
                  type="button"
                  onClick={openSettings}
                  className="mt-2 text-xs font-medium text-accent hover:underline"
                >
                  Set up optional AI features
                </button>
              </div>
              <button
                type="button"
                aria-label="Dismiss first-run explanation"
                onClick={dismissFirstRun}
                className="text-xs font-medium text-foreground/55 hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          </section>
        )}

        <SaveBar />
        <div>
          <input
            type="search"
            aria-label="Search saved pages"
            placeholder="Search saved pages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-md border border-default bg-surface-raised px-3 py-2 text-sm text-foreground outline-none placeholder:text-foreground/45 focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <p className="mt-1 text-xs text-foreground/55" aria-live="polite">
            <span>{modeText(searchMode)}</span>{" "}
            <button
              type="button"
              onClick={openSettings}
              className="font-medium text-accent hover:underline"
            >
              Settings
            </button>
          </p>
        </div>

        <div className="flex gap-2">
          {filters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filter === activeFilter}
              onClick={() => setActiveFilter(filter)}
              className="rounded-full border border-default bg-surface-raised px-3 py-1 text-sm text-foreground/75 transition-colors hover:bg-foreground/5 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-white"
            >
              {filter}
            </button>
          ))}
        </div>

        {isSearching ? (
          searching ? (
            <p className="text-sm text-foreground/65">Searching...</p>
          ) : filteredHits.length === 0 ? (
            <section className="rounded-md border border-dashed border-default bg-surface-raised px-4 py-8 text-center">
              <h2 className="text-sm font-semibold text-foreground">No matches for your search</h2>
              <p className="mt-2 text-sm text-foreground/65">Try different keywords.</p>
            </section>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredHits.map((hit) => (
                <SearchResultCard key={hit.page.id} hit={hit} onDelete={handleDelete} />
              ))}
            </div>
          )
        ) : loading ? (
          <p className="text-sm text-foreground/65">Loading library...</p>
        ) : filteredPages.length === 0 ? (
          <section className="rounded-md border border-dashed border-default bg-surface-raised px-4 py-8 text-center">
            <h2 className="text-sm font-semibold text-foreground">No saved pages yet</h2>
            <p className="mt-2 text-sm text-foreground/65">Saved pages will appear here.</p>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredPages.map((page) => (
              <PageCard
                key={page.id}
                page={page}
                hasApiKey={hasApiKey}
                onAddAiFeatures={handleAddAiFeatures}
                onDelete={handleDelete}
                onOpenSettings={openSettings}
                onRetry={handleRetry}
              />
            ))}
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}
