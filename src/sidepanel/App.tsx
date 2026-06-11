import { useCallback, useEffect, useState } from "react";

import type { WorkerBroadcast } from "../shared/messages";
import type { PageHit, PageListItem, SourceType } from "../shared/types";
import { PageCard, SearchResultCard, SurfaceShell } from "../ui/components";
import { sendRequest, subscribeToBroadcasts } from "../ui/rpc";
import { SaveBar } from "./SaveBar";

const filters = ["All", "Docs", "SO", "GH"] as const;
type Filter = (typeof filters)[number];

const filterToSourceType: Record<Exclude<Filter, "All">, SourceType> = {
  Docs: "official_docs",
  SO: "stackoverflow",
  GH: "github_issue",
};

type AppProps = {
  listPages?: () => Promise<PageListItem[]>;
  runSearch?: (query: string) => Promise<PageHit[]>;
  deletePage?: (id: string) => Promise<void>;
  retryPage?: (id: string) => Promise<void>;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
};

async function defaultListPages(): Promise<PageListItem[]> {
  const response = await sendRequest(
    { type: "page.list", payload: { limit: 50 } },
    "page.listed",
  );
  return response?.payload.pages ?? [];
}

async function defaultRunSearch(query: string): Promise<PageHit[]> {
  const response = await sendRequest(
    { type: "search.run", payload: { query } },
    "search.results",
  );
  return response?.payload.hits ?? [];
}

async function defaultDeletePage(id: string): Promise<void> {
  await sendRequest({ type: "page.delete", payload: { id } }, "page.deleted");
}

async function defaultRetryPage(id: string): Promise<void> {
  await sendRequest({ type: "page.retry", payload: { id } }, "page.retryStarted");
}

const defaultSubscribe = subscribeToBroadcasts;

export function App({
  listPages = defaultListPages,
  runSearch = defaultRunSearch,
  deletePage = defaultDeletePage,
  retryPage = defaultRetryPage,
  subscribe = defaultSubscribe,
}: AppProps) {
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hits, setHits] = useState<PageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeFilter, setActiveFilter] = useState<Filter>("All");

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

  useEffect(() => {
    if (submittedQuery.length === 0) {
      setHits([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    void runSearch(submittedQuery).then((nextHits) => {
      if (!cancelled) {
        setHits(nextHits);
        setSearching(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [submittedQuery, runSearch]);

  // Live refresh: reconcile the library list in place from worker broadcasts.
  // Search results are a query snapshot and are intentionally left untouched.
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type === "page.updated") {
        setPages((prev) => {
          const index = prev.findIndex((p) => p.id === message.payload.page.id);
          if (index === -1) {
            return [message.payload.page, ...prev];
          }
          const next = prev.slice();
          next[index] = message.payload.page;
          return next;
        });
      } else if (message.type === "page.removed") {
        setPages((prev) => prev.filter((p) => p.id !== message.payload.id));
      } else if (message.type === "library.cleared") {
        setPages([]);
        setQuery("");
        setSubmittedQuery("");
        setHits([]);
        setSearching(false);
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

  const filteredPages =
    activeFilter === "All"
      ? pages
      : pages.filter((page) => page.sourceType === filterToSourceType[activeFilter]);
  const filteredHits =
    activeFilter === "All"
      ? hits
      : hits.filter((hit) => hit.page.sourceType === filterToSourceType[activeFilter]);

  const isSearching = submittedQuery.length > 0;

  return (
    <SurfaceShell
      title="DevRecall"
      actions={
        <button
          type="button"
          aria-label="Settings"
          className="rounded-md border border-default bg-surface-raised px-2 py-1 text-sm text-foreground/75 transition-colors hover:bg-foreground/5"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Settings
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <SaveBar />
        <input
          type="search"
          aria-label="Search saved pages"
          placeholder="Search saved pages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded-md border border-default bg-surface-raised px-3 py-2 text-sm text-foreground outline-none placeholder:text-foreground/45 focus:border-accent focus:ring-2 focus:ring-accent/20"
        />

        <div className="flex gap-2">
          {filters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filter === activeFilter}
              onClick={() => setActiveFilter(filter)}
              className="rounded-md border border-default bg-surface-raised px-3 py-1 text-sm text-foreground/75 transition-colors hover:bg-foreground/5 aria-pressed:border-accent/40 aria-pressed:bg-accent/10 aria-pressed:text-accent"
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
              <PageCard key={page.id} page={page} onDelete={handleDelete} onRetry={handleRetry} />
            ))}
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}
