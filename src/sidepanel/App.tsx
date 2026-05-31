import { useCallback, useEffect, useState } from "react";

import type { DevRecallRequest, DevRecallResponse, WorkerBroadcast } from "../shared/messages";
import type { PageHit, PageListItem } from "../shared/types";
import { PageCard, SearchResultCard, SurfaceShell } from "../ui/components";

const filters = ["All", "Docs", "SO", "GH"] as const;

type AppProps = {
  listPages?: () => Promise<PageListItem[]>;
  runSearch?: (query: string) => Promise<PageHit[]>;
  deletePage?: (id: string) => Promise<void>;
  subscribe?: (handler: (message: WorkerBroadcast) => void) => () => void;
};

async function defaultListPages(): Promise<PageListItem[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }

  try {
    const request: DevRecallRequest = { type: "page.list", payload: { limit: 50 } };
    const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;

    if (response.type !== "page.listed") {
      return [];
    }

    return response.payload.pages ?? [];
  } catch {
    return [];
  }
}

async function defaultRunSearch(query: string): Promise<PageHit[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }

  try {
    const request: DevRecallRequest = { type: "search.run", payload: { query } };
    const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;

    if (response.type !== "search.results") {
      return [];
    }

    return response.payload.hits ?? [];
  } catch {
    return [];
  }
}

async function defaultDeletePage(id: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return;
  }

  const request: DevRecallRequest = { type: "page.delete", payload: { id } };
  await chrome.runtime.sendMessage(request);
}

function defaultSubscribe(handler: (message: WorkerBroadcast) => void): () => void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
    return () => {};
  }

  const listener = (message: unknown) => {
    handler(message as WorkerBroadcast);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function App({
  listPages = defaultListPages,
  runSearch = defaultRunSearch,
  deletePage = defaultDeletePage,
  subscribe = defaultSubscribe,
}: AppProps) {
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hits, setHits] = useState<PageHit[]>([]);
  const [searching, setSearching] = useState(false);

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

  const isSearching = submittedQuery.length > 0;

  return (
    <SurfaceShell
      title="DevRecall"
      actions={
        <button
          type="button"
          aria-label="Settings"
          className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Settings
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <input
          type="search"
          aria-label="Search saved pages"
          placeholder="Search saved pages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <div className="flex gap-2">
          {filters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filter === "All"}
              className="rounded-md border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 aria-pressed:border-accent aria-pressed:text-accent"
            >
              {filter}
            </button>
          ))}
        </div>

        {isSearching ? (
          searching ? (
            <p className="text-sm text-slate-500">Searching...</p>
          ) : hits.length === 0 ? (
            <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
              <h2 className="text-sm font-semibold text-slate-900">No matches for your search</h2>
              <p className="mt-2 text-sm text-slate-500">Try different keywords.</p>
            </section>
          ) : (
            <div className="flex flex-col gap-3">
              {hits.map((hit) => (
                <SearchResultCard key={hit.page.id} hit={hit} onDelete={handleDelete} />
              ))}
            </div>
          )
        ) : loading ? (
          <p className="text-sm text-slate-500">Loading library...</p>
        ) : pages.length === 0 ? (
          <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
            <h2 className="text-sm font-semibold text-slate-900">No saved pages yet</h2>
            <p className="mt-2 text-sm text-slate-500">Saved pages will appear here.</p>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {pages.map((page) => (
              <PageCard key={page.id} page={page} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}
