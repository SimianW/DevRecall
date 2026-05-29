import { useEffect, useState } from "react";

import type { DevRecallRequest, DevRecallResponse } from "../shared/messages";
import type { PageListItem } from "../shared/types";
import { PageCard, SurfaceShell } from "../ui/components";

const filters = ["All", "Docs", "SO", "GH"] as const;

type AppProps = {
  listPages?: () => Promise<PageListItem[]>;
};

async function defaultListPages(): Promise<PageListItem[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }

  try {
    const request: DevRecallRequest = {
      type: "page.list",
      payload: { limit: 50 },
    };
    const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse;

    if (response.type !== "page.listed") {
      return [];
    }

    return response.payload.pages ?? [];
  } catch {
    return [];
  }
}

export function App({ listPages = defaultListPages }: AppProps) {
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [loading, setLoading] = useState(true);

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

        {loading ? (
          <p className="text-sm text-slate-500">Loading library...</p>
        ) : pages.length === 0 ? (
          <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
            <h2 className="text-sm font-semibold text-slate-900">No saved pages yet</h2>
            <p className="mt-2 text-sm text-slate-500">Saved pages will appear here.</p>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {pages.map((page) => (
              <PageCard key={page.id} page={page} />
            ))}
          </div>
        )}
      </div>
    </SurfaceShell>
  );
}
