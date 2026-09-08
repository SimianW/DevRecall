import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ContentType, Platform } from "../shared/enums";
import type {
  DevRecallResponse,
  PageListItemWithExcerpt,
  WorkerBroadcast,
} from "../shared/messages";
import type { PageHit, SearchFilter } from "../shared/types";
import type { EffectiveMode } from "../shared/modes";
import { PageCard, SearchResultCard, SurfaceShell } from "../ui/components";
import { requireResponse, subscribeToBroadcasts } from "../ui/rpc";
import { SaveBar } from "./SaveBar";

const filters = ["All", "Docs", "Stack Overflow", "GitHub"] as const;
type Filter = (typeof filters)[number];
type SearchResult = Extract<DevRecallResponse, { type: "search.results" }>["payload"];
type SearchMode = SearchResult["searchMode"];
type ListRequest = { limit: number; offset?: number; filter?: SearchFilter };
type SearchStatus = Pick<
  Extract<DevRecallResponse, { type: "settings.status" }>["payload"],
  "hasApiKey" | "effectiveMode"
>;

const FIRST_RUN_DISMISSED_KEY = "devrecall.firstRunExplanationDismissed";

type AppProps = {
  listPages?: (request?: ListRequest) => Promise<PageListItemWithExcerpt[]>;
  loadSearchStatus?: () => Promise<SearchStatus>;
  runSearch?: (query: string, filter?: SearchFilter) => Promise<SearchResult>;
  addAiFeatures?: (id: string) => Promise<void>;
  deletePage?: (id: string) => Promise<void>;
  retryPage?: (id: string) => Promise<void>;
  openSettings?: () => void;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
};

const PAGE_SIZE = 50;

async function defaultListPages(
  request: ListRequest = { limit: PAGE_SIZE, offset: 0 },
): Promise<PageListItemWithExcerpt[]> {
  const payload = {
    limit: request.limit,
    ...(request.offset ? { offset: request.offset } : {}),
    ...(request.filter ? { filter: request.filter } : {}),
  };
  const response = await requireResponse(
    {
      type: "page.list",
      payload,
    },
    "page.listed",
  );
  return response.payload.pages;
}

async function defaultLoadSearchStatus(): Promise<SearchStatus> {
  const response = await requireResponse({ type: "settings.getStatus" }, "settings.status");
  return {
    hasApiKey: response.payload.hasApiKey,
    effectiveMode: response.payload.effectiveMode,
  };
}

async function defaultRunSearch(query: string, filter?: SearchFilter): Promise<SearchResult> {
  const response = await requireResponse(
    { type: "search.run", payload: filter ? { query, filter } : { query } },
    "search.results",
  );
  return response.payload;
}

async function defaultAddAiFeatures(id: string): Promise<void> {
  await requireResponse(
    { type: "page.addAiFeatures", payload: { pageId: id } },
    "page.aiFeaturesStarted",
  );
}

async function defaultDeletePage(id: string): Promise<void> {
  await requireResponse({ type: "page.delete", payload: { id } }, "page.deleted");
}

async function defaultRetryPage(id: string): Promise<void> {
  await requireResponse({ type: "page.retry", payload: { id } }, "page.retryStarted");
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

function toSearchFilter(filter: Filter): SearchFilter | undefined {
  switch (filter) {
    case "Docs":
      return { contentType: ContentType.Documentation };
    case "Stack Overflow":
      return { platform: Platform.StackOverflow };
    case "GitHub":
      return { platform: Platform.Github };
    case "All":
      return undefined;
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
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hits, setHits] = useState<PageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState<SearchMode | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<EffectiveMode>("local");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const searchFilter = useMemo(() => toSearchFilter(activeFilter), [activeFilter]);
  const [showFirstRun, setShowFirstRun] = useState(() => !wasFirstRunDismissed());
  const [searchRevision, setSearchRevision] = useState(0);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMorePages, setHasMorePages] = useState(false);
  const [browseLimit, setBrowseLimit] = useState(PAGE_SIZE);
  const [pendingActions, setPendingActions] = useState<Record<string, "delete" | "retry" | "ai">>(
    {},
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);
  const libraryRequestRef = useRef(0);
  const livePageUpdatesRef = useRef(new Map<string, PageListItemWithExcerpt>());
  const liveRemovedIdsRef = useRef(new Set<string>());
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
    const requestId = ++libraryRequestRef.current;

    async function loadPages() {
      setLoading(true);
      setLoadingMore(browseLimit > PAGE_SIZE);
      setLibraryError(null);
      try {
        const nextPages = await listPages({ limit: browseLimit, filter: searchFilter });
        if (!cancelled && requestId === libraryRequestRef.current) {
          const removed = liveRemovedIdsRef.current;
          const merged = new Map(nextPages.map((page) => [page.id, page]));
          for (const [id, page] of livePageUpdatesRef.current) {
            if (!removed.has(id)) merged.set(id, page);
          }
          setPages([...merged.values()].filter((page) => !removed.has(page.id)));
          setHasMorePages(nextPages.length >= browseLimit);
          setLoading(false);
          setLoadingMore(false);
        }
      } catch {
        if (!cancelled && requestId === libraryRequestRef.current) {
          setPages([]);
          setLoading(false);
          setLoadingMore(false);
          setLibraryError("We couldn't load your saved pages.");
        }
      }
    }

    void loadPages();
    return () => {
      cancelled = true;
    };
  }, [activeFilter, browseLimit, libraryRevision, listPages, searchFilter]);

  const loadMorePages = useCallback(() => {
    if (loadingMore || !hasMorePages) return;
    setBrowseLimit((value) => value + PAGE_SIZE);
  }, [hasMorePages, loadingMore]);

  const retryLibrary = useCallback(() => {
    setLoading(true);
    setLibraryError(null);
    setLibraryRevision((value) => value + 1);
  }, []);

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
      searchRequestRef.current += 1;
      setHits([]);
      setSearchMode(effectiveMode);
      setSearching(false);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    const requestId = ++searchRequestRef.current;
    setHits([]);
    setSearching(true);
    setSearchError(null);

    const searchPromise = searchFilter
      ? runSearch(submittedQuery, searchFilter)
      : runSearch(submittedQuery);
    void searchPromise
      .then((result) => {
        if (!cancelled && requestId === searchRequestRef.current) {
          setHits(result.results);
          setSearchMode(result.searchMode);
          setSearching(false);
        }
      })
      .catch(() => {
        if (!cancelled && requestId === searchRequestRef.current) {
          setHits([]);
          setSearching(false);
          setSearchError("Search couldn't be completed.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveMode, searchFilter, searchRevision, submittedQuery, runSearch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (
        (event.key === "k" && (event.metaKey || event.ctrlKey)) ||
        (event.key === "/" && !isTyping)
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      if (event.key === "Escape" && (document.activeElement === searchInputRef.current || query)) {
        setQuery("");
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [query]);

  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      const rerunActiveSearch = () => {
        if (submittedQueryRef.current.length > 0) {
          // Invalidate the in-flight result immediately, then rerun against the
          // worker's latest index after React commits the broadcast update.
          searchRequestRef.current += 1;
          setHits([]);
          setSearching(true);
          setSearchRevision((value) => value + 1);
        }
      };

      // Import/backup replacement can change many records at once. Reload the
      // list instead of trying to reconcile an incomplete set of page events.
      if (message.type === "library.changed") {
        libraryRequestRef.current += 1;
        livePageUpdatesRef.current.clear();
        liveRemovedIdsRef.current.clear();
        setBrowseLimit(PAGE_SIZE);
        setLibraryRevision((value) => value + 1);
        rerunActiveSearch();
      } else if (message.type === "page.updated") {
        const broadcastPage = message.payload.page;
        setPages((previous) => {
          const index = previous.findIndex((page) => page.id === broadcastPage.id);
          const nextPage = {
            ...message.payload.page,
            excerpt: message.payload.page.excerpt ?? (index === -1 ? "" : previous[index].excerpt),
          };
          livePageUpdatesRef.current.set(nextPage.id, nextPage);
          liveRemovedIdsRef.current.delete(nextPage.id);
          if (index === -1) return [nextPage, ...previous];
          const next = previous.slice();
          next[index] = nextPage;
          return next;
        });
        rerunActiveSearch();
      } else if (message.type === "page.removed") {
        liveRemovedIdsRef.current.add(message.payload.id);
        livePageUpdatesRef.current.delete(message.payload.id);
        setPages((previous) => previous.filter((page) => page.id !== message.payload.id));
        rerunActiveSearch();
      } else if (message.type === "library.cleared") {
        libraryRequestRef.current += 1;
        searchRequestRef.current += 1;
        submittedQueryRef.current = "";
        livePageUpdatesRef.current.clear();
        liveRemovedIdsRef.current.clear();
        setPages([]);
        setHasMorePages(false);
        setLoading(false);
        setLoadingMore(false);
        setLibraryError(null);
        setActionError(null);
        setQuery("");
        setSubmittedQuery("");
        setHits([]);
        setSearching(false);
        setSearchError(null);
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

  const beginAction = useCallback((id: string, action: "delete" | "retry" | "ai") => {
    setPendingActions((previous) => ({ ...previous, [id]: action }));
  }, []);

  const finishAction = useCallback((id: string) => {
    setPendingActions((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      const page =
        pages.find((candidate) => candidate.id === id) ??
        hits.find((hit) => hit.page.id === id)?.page;
      if (
        typeof window !== "undefined" &&
        !window.confirm(`Delete “${page?.title ?? "this page"}” from your library?`)
      ) {
        return;
      }
      beginAction(id, "delete");
      setActionError(null);
      void deletePage(id)
        .then(() => {
          setPages((previous) => previous.filter((candidate) => candidate.id !== id));
          setHits((previous) => previous.filter((hit) => hit.page.id !== id));
        })
        .catch(() => setActionError("Page couldn't be deleted. Try again."))
        .finally(() => finishAction(id));
    },
    [beginAction, deletePage, finishAction, hits, pages],
  );

  const handleRetry = useCallback(
    (id: string) => {
      beginAction(id, "retry");
      setActionError(null);
      void retryPage(id)
        .catch(() => setActionError("Retry couldn't be started. Try again."))
        .finally(() => finishAction(id));
    },
    [beginAction, finishAction, retryPage],
  );

  const handleAddAiFeatures = useCallback(
    (id: string) => {
      beginAction(id, "ai");
      setActionError(null);
      void addAiFeatures(id)
        .catch(() => setActionError("AI features couldn't be started. Try again."))
        .finally(() => finishAction(id));
    },
    [addAiFeatures, beginAction, finishAction],
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
        {actionError && (
          <p
            role="alert"
            className="rounded-md border border-red-500/25 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          >
            {actionError}
          </p>
        )}
        <div>
          <div className="relative">
            <input
              ref={searchInputRef}
              type="search"
              aria-label="Search saved pages"
              placeholder="Search saved pages"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  searchInputRef.current?.focus();
                }
              }}
              className="w-full rounded-md border border-default bg-surface-raised px-3 py-2 pr-20 text-sm text-foreground outline-none placeholder:text-foreground/45 focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs font-medium text-foreground/60 hover:bg-foreground/5 hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-foreground/55" aria-live="polite">
            <span>{modeText(searchMode)}</span>{" "}
            <span className="text-foreground/45">· Press / or Ctrl K to focus</span>{" "}
            <button
              type="button"
              onClick={openSettings}
              className="font-medium text-accent hover:underline"
            >
              Settings
            </button>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {filters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filter === activeFilter}
              onClick={() => {
                setActiveFilter(filter);
                setBrowseLimit(PAGE_SIZE);
              }}
              className="rounded-full border border-default bg-surface-raised px-3 py-1 text-sm text-foreground/75 transition-colors hover:bg-foreground/5 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-white"
            >
              {filter}
            </button>
          ))}
        </div>

        {isSearching ? (
          searching ? (
            <p className="text-sm text-foreground/65">Searching...</p>
          ) : searchError ? (
            <section
              role="alert"
              className="rounded-md border border-red-500/25 bg-red-500/5 px-4 py-6 text-center"
            >
              <h2 className="text-sm font-semibold text-foreground">Search unavailable</h2>
              <p className="mt-2 text-sm text-foreground/65">{searchError}</p>
              <button
                type="button"
                onClick={() => {
                  searchRequestRef.current += 1;
                  setSearchRevision((value) => value + 1);
                }}
                className="mt-3 text-xs font-medium text-accent hover:underline"
              >
                Retry search
              </button>
            </section>
          ) : filteredHits.length === 0 ? (
            <section className="rounded-md border border-dashed border-default bg-surface-raised px-4 py-8 text-center">
              <h2 className="text-sm font-semibold text-foreground">
                {hits.length > 0 ? `No matches in ${activeFilter}` : "No matches for your search"}
              </h2>
              <p className="mt-2 text-sm text-foreground/65">
                {hits.length > 0 ? "Try another filter." : "Try different keywords."}
              </p>
            </section>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-foreground/55" aria-live="polite">
                {filteredHits.length} {filteredHits.length === 1 ? "result" : "results"}
                {filteredHits.length !== hits.length ? ` · ${hits.length} total` : ""}
              </p>
              {filteredHits.map((hit) => (
                <SearchResultCard
                  key={hit.page.id}
                  hit={hit}
                  onDelete={handleDelete}
                  pendingAction={pendingActions[hit.page.id] === "delete" ? "delete" : undefined}
                />
              ))}
            </div>
          )
        ) : loading ? (
          <p className="text-sm text-foreground/65">Loading library...</p>
        ) : libraryError ? (
          <section
            role="alert"
            className="rounded-md border border-red-500/25 bg-red-500/5 px-4 py-6 text-center"
          >
            <h2 className="text-sm font-semibold text-foreground">Library unavailable</h2>
            <p className="mt-2 text-sm text-foreground/65">{libraryError}</p>
            <button
              type="button"
              onClick={retryLibrary}
              className="mt-3 text-xs font-medium text-accent hover:underline"
            >
              Retry loading library
            </button>
          </section>
        ) : filteredPages.length === 0 ? (
          <section className="rounded-md border border-dashed border-default bg-surface-raised px-4 py-8 text-center">
            <h2 className="text-sm font-semibold text-foreground">
              {pages.length > 0 ? `No pages match ${activeFilter}` : "No saved pages yet"}
            </h2>
            <p className="mt-2 text-sm text-foreground/65">
              {pages.length > 0 ? "Try another filter." : "Saved pages will appear here."}
            </p>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-foreground/55" aria-live="polite">
              {filteredPages.length} {filteredPages.length === 1 ? "saved page" : "saved pages"}
              {filteredPages.length !== pages.length ? ` · ${pages.length} total` : ""}
            </p>
            {filteredPages.map((page) => (
              <PageCard
                key={page.id}
                page={page}
                hasApiKey={hasApiKey}
                onAddAiFeatures={handleAddAiFeatures}
                onDelete={handleDelete}
                onOpenSettings={openSettings}
                onRetry={handleRetry}
                pendingAction={pendingActions[page.id]}
              />
            ))}
            {hasMorePages && (
              <button
                type="button"
                onClick={() => void loadMorePages()}
                disabled={loadingMore}
                className="self-center rounded-md border border-default px-3 py-2 text-xs font-medium text-accent hover:bg-foreground/5 disabled:cursor-wait disabled:opacity-60"
              >
                {loadingMore ? "Loading…" : "Load more pages"}
              </button>
            )}
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}
