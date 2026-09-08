import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContentType, Platform } from "../shared/enums";
import type { PageListItemWithExcerpt, WorkerBroadcast } from "../shared/messages";
import type { PageHit, PageListItem } from "../shared/types";
import { App } from "./App";

function makeSubscribe() {
  let handler: ((message: WorkerBroadcast) => void) | null = null;
  return {
    subscribe: (next: (message: WorkerBroadcast) => void) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
    emit: async (message: WorkerBroadcast) => {
      await act(async () => handler?.(message));
    },
  };
}

function makePage(overrides: Partial<PageListItemWithExcerpt> = {}): PageListItemWithExcerpt {
  return {
    id: "01HZ0000000000000000000000",
    url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
    title: "Horizontal Pod Autoscaling",
    domain: "kubernetes.io",
    platform: Platform.Web,
    contentType: ContentType.Documentation,
    summary: "",
    excerpt: "The autoscaler changes replica counts based on observed resource use.",
    topics: [],
    technologies: [],
    savedAt: 100,
    status: "ready",
    ...overrides,
  };
}

function makeHit(page = makePage()): PageHit {
  return {
    page,
    bestChunk: {
      text: "The HorizontalPodAutoscaler automatically scales pods.",
      ordinal: 0,
      highlightedHtml: "The HorizontalPodAutoscaler automatically scales <mark>pods</mark>.",
    },
    metadataMatches: { titleHighlightedHtml: null, summaryHighlightedHtml: null },
    scores: { keyword: 2.1, vector: null, fused: 2.1 },
    matchReason: "keyword",
  };
}

const localStatus = { hasApiKey: false, effectiveMode: "local" as const };

function renderApp(props: Partial<React.ComponentProps<typeof App>> = {}) {
  const defaults = {
    listPages: vi.fn().mockResolvedValue([]),
    loadSearchStatus: vi.fn().mockResolvedValue(localStatus),
    runSearch: vi.fn().mockResolvedValue({ results: [], searchMode: "local" as const }),
    subscribe: makeSubscribe().subscribe,
    openSettings: vi.fn(),
    ...props,
  };
  return { ...render(<App {...defaults} />), props: defaults, user: userEvent.setup() };
}

beforeEach(() => {
  localStorage.clear();
});

describe("Side panel search", () => {
  it("does not restore pages when an initial library read finishes after clear", async () => {
    let finishRead!: (pages: PageListItemWithExcerpt[]) => void;
    const listPages = vi.fn(
      () =>
        new Promise<PageListItemWithExcerpt[]>((resolve) => {
          finishRead = resolve;
        }),
    );
    const broadcast = makeSubscribe();
    renderApp({ listPages, subscribe: broadcast.subscribe });
    await broadcast.emit({ type: "library.cleared" });
    await act(async () => finishRead([makePage()]));
    expect(screen.getByRole("heading", { name: "No saved pages yet" })).toBeInTheDocument();
    expect(screen.queryByText("Horizontal Pod Autoscaling")).not.toBeInTheDocument();
  });

  it("does not restore older pages when load-more finishes after clear", async () => {
    let finishRead!: (pages: PageListItemWithExcerpt[]) => void;
    const listPages = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, index) =>
          makePage({ id: String(index), title: `Page ${index}` }),
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<PageListItemWithExcerpt[]>((resolve) => {
            finishRead = resolve;
          }),
      );
    const broadcast = makeSubscribe();
    const { user } = renderApp({ listPages, subscribe: broadcast.subscribe });
    await user.click(await screen.findByRole("button", { name: "Load more pages" }));
    await broadcast.emit({ type: "library.cleared" });
    await act(async () => finishRead([makePage()]));
    expect(screen.getByRole("heading", { name: "No saved pages yet" })).toBeInTheDocument();
    expect(screen.queryByText("Horizontal Pod Autoscaling")).not.toBeInTheDocument();
  });

  it("reruns an active query when a page broadcast changes the index", async () => {
    const first = makeHit();
    const refreshed = makeHit(makePage({ id: "refreshed", title: "Fresh autoscaler result" }));
    let resolveInitial!: (value: { results: PageHit[]; searchMode: "local" }) => void;
    const initial = new Promise<{ results: PageHit[]; searchMode: "local" }>((resolve) => {
      resolveInitial = resolve;
    });
    const runSearch = vi
      .fn()
      .mockReturnValueOnce(initial)
      .mockResolvedValue({ results: [refreshed], searchMode: "local" as const });
    const broadcast = makeSubscribe();
    const { user } = renderApp({ runSearch, subscribe: broadcast.subscribe });
    const input = screen.getByRole("searchbox", { name: "Search saved pages" });

    await user.type(input, "pods");
    await waitFor(() => expect(runSearch).toHaveBeenCalledWith("pods"));
    await broadcast.emit({ type: "page.updated", payload: { page: makePage() } });
    expect(await screen.findByText("Fresh autoscaler result")).toBeInTheDocument();

    resolveInitial({ results: [first], searchMode: "local" });
    await act(async () => {});
    expect(screen.queryByText("Horizontal Pod Autoscaling")).not.toBeInTheDocument();
    expect(runSearch).toHaveBeenCalledTimes(2);
  });

  it("does not restore a deleted hit when an older search resolves late", async () => {
    let resolveOld!: (value: { results: PageHit[]; searchMode: "local" }) => void;
    const oldSearch = new Promise<{ results: PageHit[]; searchMode: "local" }>((resolve) => {
      resolveOld = resolve;
    });
    const runSearch = vi
      .fn()
      .mockReturnValueOnce(oldSearch)
      .mockResolvedValueOnce({ results: [], searchMode: "local" as const });
    const broadcast = makeSubscribe();
    const { user } = renderApp({ runSearch, subscribe: broadcast.subscribe });
    const input = screen.getByRole("searchbox", { name: "Search saved pages" });
    await user.type(input, "pods");
    await waitFor(() => expect(runSearch).toHaveBeenCalledWith("pods"));

    await broadcast.emit({ type: "page.removed", payload: { id: makePage().id } });
    resolveOld({ results: [makeHit()], searchMode: "local" });
    await waitFor(() => expect(runSearch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Horizontal Pod Autoscaling")).not.toBeInTheDocument();
  });

  it("shows a search error and retries the same query", async () => {
    const runSearch = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker unavailable"))
      .mockResolvedValueOnce({ results: [makeHit()], searchMode: "local" as const });
    const { user } = renderApp({ runSearch });
    await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "pods");

    expect(await screen.findByRole("alert")).toHaveTextContent("Search unavailable");
    await user.click(screen.getByRole("button", { name: "Retry search" }));
    expect(await screen.findByText("Horizontal Pod Autoscaling")).toBeInTheDocument();
    expect(runSearch).toHaveBeenCalledTimes(2);
  });

  it("clears the query and results with Escape", async () => {
    const { user } = renderApp({
      runSearch: vi.fn().mockResolvedValue({ results: [makeHit()], searchMode: "local" as const }),
    });
    const input = screen.getByRole("searchbox", { name: "Search saved pages" });
    await user.type(input, "pods");
    expect(await screen.findByText("Horizontal Pod Autoscaling")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    await waitFor(() =>
      expect(screen.queryByText("Horizontal Pod Autoscaling")).not.toBeInTheDocument(),
    );
  });

  it("passes the selected filter to server-side search", async () => {
    const runSearch = vi.fn().mockResolvedValue({ results: [], searchMode: "local" as const });
    const { user } = renderApp({ runSearch });
    await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "pods");
    await waitFor(() => expect(runSearch).toHaveBeenCalledWith("pods"));
    await user.click(screen.getByRole("button", { name: "Stack Overflow" }));
    await waitFor(() =>
      expect(runSearch).toHaveBeenLastCalledWith("pods", { platform: Platform.StackOverflow }),
    );
  });

  it("shows an action error when AI processing cannot be started", async () => {
    const addAiFeatures = vi.fn().mockRejectedValue(new Error("worker unavailable"));
    const { user } = renderApp({
      listPages: vi.fn().mockResolvedValue([makePage({ status: "keyword_ready" })]),
      loadSearchStatus: vi.fn().mockResolvedValue({ hasApiKey: true, effectiveMode: "local" }),
      addAiFeatures,
    });
    await user.click(await screen.findByRole("button", { name: "Add AI features" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI features couldn't be started");
    expect(addAiFeatures).toHaveBeenCalledWith(makePage().id);
  });

  it("shows a library error and retries loading it", async () => {
    const listPages = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([makePage({ title: "Recovered page" })]);
    const { user } = renderApp({ listPages });
    expect(await screen.findByRole("alert")).toHaveTextContent("Library unavailable");
    await user.click(screen.getByRole("button", { name: "Retry loading library" }));
    expect(await screen.findByText("Recovered page")).toBeInTheDocument();
    expect(listPages).toHaveBeenCalledTimes(2);
  });

  it("shows the configured mode before a search completes and links to Settings", async () => {
    const openSettings = vi.fn();
    const { user } = renderApp({
      loadSearchStatus: vi.fn().mockResolvedValue({ hasApiKey: true, effectiveMode: "hybrid" }),
      openSettings,
    });

    expect(await screen.findByText("Hybrid")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Settings" })[1]);
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("uses the worker's fallback mode while keeping keyword results", async () => {
    const { user } = renderApp({
      loadSearchStatus: vi.fn().mockResolvedValue({ hasApiKey: true, effectiveMode: "hybrid" }),
      runSearch: vi.fn().mockResolvedValue({
        results: [makeHit()],
        searchMode: "keyword_fallback",
      }),
    });

    await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "pods");

    expect(await screen.findByText("Horizontal Pod Autoscaling")).toBeInTheDocument();
    expect(
      screen.getByText("Semantic search unavailable. Showing keyword results."),
    ).toBeInTheDocument();
  });

  it("replaces a fallback label after the next successful Hybrid search", async () => {
    const runSearch = vi
      .fn()
      .mockResolvedValueOnce({ results: [makeHit()], searchMode: "keyword_fallback" })
      .mockResolvedValueOnce({ results: [makeHit()], searchMode: "hybrid" });
    const { user } = renderApp({ runSearch });
    const input = screen.getByRole("searchbox", { name: "Search saved pages" });

    await user.type(input, "pods");
    expect(
      await screen.findByText("Semantic search unavailable. Showing keyword results."),
    ).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "autoscaler");

    expect(await screen.findByText("Hybrid")).toBeInTheDocument();
    expect(
      screen.queryByText("Semantic search unavailable. Showing keyword results."),
    ).not.toBeInTheDocument();
  });
});

describe("Side panel library", () => {
  it("keeps a live page update that arrives while the initial list is loading", async () => {
    let resolveList!: (pages: PageListItemWithExcerpt[]) => void;
    const listPages = vi.fn().mockReturnValue(
      new Promise<PageListItemWithExcerpt[]>((resolve) => {
        resolveList = resolve;
      }),
    );
    const broadcast = makeSubscribe();
    renderApp({ listPages, subscribe: broadcast.subscribe });
    await broadcast.emit({
      type: "page.updated",
      payload: { page: makePage({ title: "Live while loading" }) },
    });
    resolveList([]);
    expect(await screen.findByText("Live while loading")).toBeInTheDocument();
  });

  it("renders the worker-provided excerpt instead of the URL", async () => {
    renderApp({ listPages: vi.fn().mockResolvedValue([makePage()]) });

    expect(await screen.findByText(/autoscaler changes replica counts/)).toBeInTheDocument();
    expect(screen.queryByText(makePage().url)).not.toBeInTheDocument();
  });

  it("filters with contentType and platform", async () => {
    const docs = makePage({ id: "docs", title: "Docs" });
    const stackOverflow = makePage({
      id: "so",
      title: "Stack Overflow question",
      platform: Platform.StackOverflow,
      contentType: ContentType.Question,
    });
    const github = makePage({
      id: "github",
      title: "GitHub issue",
      platform: Platform.Github,
      contentType: ContentType.Issue,
    });
    const { user } = renderApp({
      listPages: vi.fn().mockResolvedValue([docs, stackOverflow, github]),
    });

    await screen.findByText("Docs");
    await user.click(screen.getByRole("button", { name: "Docs" }));
    expect(screen.getByRole("heading", { name: "Docs" })).toBeInTheDocument();
    expect(screen.queryByText("Stack Overflow question")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stack Overflow" }));
    expect(screen.getByText("Stack Overflow question")).toBeInTheDocument();
    expect(screen.queryByText("GitHub issue")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "GitHub" }));
    expect(screen.getByText("GitHub issue")).toBeInTheDocument();
  });

  it("asks the worker to filter before paging so matches beyond the first page remain visible", async () => {
    const olderStackOverflowPage = makePage({
      id: "older-so",
      title: "Older Stack Overflow answer",
      platform: Platform.StackOverflow,
    });
    const firstPage = Array.from({ length: 50 }, (_, index) => makePage({ id: `page-${index}` }));
    const listPages = vi
      .fn()
      .mockImplementation((request?: { filter?: unknown }) =>
        Promise.resolve(request?.filter ? [olderStackOverflowPage] : firstPage),
      );
    const { user } = renderApp({ listPages });
    await screen.findAllByRole("heading", { name: "Horizontal Pod Autoscaling" });
    await user.click(screen.getByRole("button", { name: "Stack Overflow" }));

    expect(
      await screen.findByRole("heading", { name: "Older Stack Overflow answer" }),
    ).toBeInTheDocument();
    expect(listPages).toHaveBeenLastCalledWith({
      limit: 50,
      filter: { platform: Platform.StackOverflow },
    });
  });

  it("loads more filtered matches with a cumulative limit", async () => {
    const firstFilteredPage = Array.from({ length: 50 }, (_, index) =>
      makePage({
        id: `stack-overflow-${index}`,
        title: `Stack Overflow answer ${index + 1}`,
        platform: Platform.StackOverflow,
      }),
    );
    const filteredPrefix = [
      ...firstFilteredPage,
      makePage({
        id: "stack-overflow-50",
        title: "Stack Overflow answer 51",
        platform: Platform.StackOverflow,
      }),
    ];
    const listPages = vi
      .fn()
      .mockImplementation((request?: { limit?: number; filter?: unknown }) =>
        Promise.resolve(
          request?.filter
            ? request.limit && request.limit > 50
              ? filteredPrefix
              : firstFilteredPage
            : [],
        ),
      );
    const { user } = renderApp({ listPages });

    await user.click(await screen.findByRole("button", { name: "Stack Overflow" }));
    await screen.findByRole("heading", { name: "Stack Overflow answer 1" });
    await user.click(screen.getByRole("button", { name: "Load more pages" }));

    expect(
      await screen.findByRole("heading", { name: "Stack Overflow answer 51" }),
    ).toBeInTheDocument();
    expect(listPages).toHaveBeenLastCalledWith({
      limit: 100,
      filter: { platform: Platform.StackOverflow },
    });
  });

  it("loads a larger prefix from offset zero instead of offsetting by rendered rows", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makePage({ id: `page-${index}` }));
    const prefix = [...firstPage, makePage({ id: "page-50", title: "Page 51" })];
    const listPages = vi
      .fn()
      .mockImplementation((request?: { limit?: number }) =>
        Promise.resolve(request?.limit && request.limit > 50 ? prefix : firstPage),
      );
    const { user } = renderApp({ listPages });
    await screen.findAllByRole("heading", { name: "Horizontal Pod Autoscaling" });
    await user.click(screen.getByRole("button", { name: "Load more pages" }));

    expect(await screen.findByRole("heading", { name: "Page 51" })).toBeInTheDocument();
    expect(listPages).toHaveBeenLastCalledWith({ limit: 100, filter: undefined });
  });

  it("sends explicit per-page consent when Add AI features is selected", async () => {
    const addAiFeatures = vi.fn().mockResolvedValue(undefined);
    const localPage = makePage({ status: "keyword_ready" });
    const { user } = renderApp({
      listPages: vi.fn().mockResolvedValue([localPage]),
      loadSearchStatus: vi.fn().mockResolvedValue({ hasApiKey: true, effectiveMode: "local" }),
      addAiFeatures,
    });

    await user.click(await screen.findByRole("button", { name: "Add AI features" }));
    expect(addAiFeatures).toHaveBeenCalledWith(localPage.id);
  });

  it("keeps Add AI features visible but disabled without a key", async () => {
    const openSettings = vi.fn();
    renderApp({
      listPages: vi.fn().mockResolvedValue([makePage({ status: "keyword_ready" })]),
      openSettings,
    });

    expect(await screen.findByRole("button", { name: "Add AI features" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Settings" }).length).toBeGreaterThan(1);
  });

  it("reconciles page.updated broadcasts", async () => {
    const { subscribe, emit } = makeSubscribe();
    renderApp({ subscribe });
    await screen.findByText("No saved pages yet");

    const page: PageListItem = makePage({ title: "Learn React" });
    await emit({ type: "page.updated", payload: { page } });
    expect(await screen.findByText("Learn React")).toBeInTheDocument();
  });

  it("updates hasApiKey and effectiveMode when settings.changed broadcast arrives", async () => {
    const { subscribe, emit } = makeSubscribe();
    renderApp({
      listPages: vi.fn().mockResolvedValue([makePage({ status: "keyword_ready" })]),
      loadSearchStatus: vi.fn().mockResolvedValue({ hasApiKey: false, effectiveMode: "local" }),
      subscribe,
    });

    expect(await screen.findByRole("button", { name: "Add AI features" })).toBeDisabled();

    await emit({
      type: "settings.changed",
      payload: { hasApiKey: true, storedMode: "hybrid", effectiveMode: "hybrid" },
    });

    expect(await screen.findByRole("button", { name: "Add AI features" })).toBeEnabled();
  });

  it("disables AI features when API key is removed via settings.changed broadcast", async () => {
    const { subscribe, emit } = makeSubscribe();
    renderApp({
      listPages: vi.fn().mockResolvedValue([makePage({ status: "keyword_ready" })]),
      loadSearchStatus: vi.fn().mockResolvedValue({ hasApiKey: true, effectiveMode: "hybrid" }),
      subscribe,
    });

    expect(await screen.findByRole("button", { name: "Add AI features" })).toBeEnabled();

    await emit({
      type: "settings.changed",
      payload: { hasApiKey: false, storedMode: "local", effectiveMode: "local" },
    });

    expect(await screen.findByRole("button", { name: "Add AI features" })).toBeDisabled();
  });

  it("preserves keyword_fallback search mode when settings.changed arrives during active results", async () => {
    const { subscribe, emit } = makeSubscribe();
    const { user } = renderApp({
      listPages: vi.fn().mockResolvedValue([makePage({ status: "keyword_ready" })]),
      loadSearchStatus: vi.fn().mockResolvedValue({ hasApiKey: false, effectiveMode: "local" }),
      runSearch: vi.fn().mockResolvedValue({
        results: [makeHit()],
        searchMode: "keyword_fallback",
      }),
      subscribe,
    });

    const input = screen.getByRole("searchbox", { name: "Search saved pages" });
    await user.type(input, "pods");

    // Verify keyword_fallback mode is shown for the results
    expect(
      await screen.findByText("Semantic search unavailable. Showing keyword results."),
    ).toBeInTheDocument();

    // Simulate API key being added while results are still displayed
    await emit({
      type: "settings.changed",
      payload: { hasApiKey: true, storedMode: "hybrid", effectiveMode: "hybrid" },
    });

    // The search mode should NOT change to "Hybrid" - results keep their actual mode
    expect(
      screen.getByText("Semantic search unavailable. Showing keyword results."),
    ).toBeInTheDocument();

    // Verify effectiveMode was updated (check by looking at what happens when we clear search)
    await user.clear(input);
    // When search is cleared, searchMode should now show the new effectiveMode
    expect(await screen.findByText("Hybrid")).toBeInTheDocument();
  });
});

describe("First run", () => {
  it("explains the local default, offers optional key setup, and can be dismissed", async () => {
    const openSettings = vi.fn();
    const { user, unmount } = renderApp({ openSettings });

    expect(screen.getByText("Your library starts local")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set up optional AI features" }));
    expect(openSettings).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Dismiss first-run explanation" }));
    expect(screen.queryByText("Your library starts local")).not.toBeInTheDocument();

    unmount();
    render(
      <App
        listPages={vi.fn().mockResolvedValue([])}
        loadSearchStatus={vi.fn().mockResolvedValue(localStatus)}
        runSearch={vi.fn().mockResolvedValue({ results: [], searchMode: "local" })}
        subscribe={makeSubscribe().subscribe}
        openSettings={openSettings}
      />,
    );
    expect(screen.queryByText("Your library starts local")).not.toBeInTheDocument();
  });
});
