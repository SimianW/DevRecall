import { act, render, screen } from "@testing-library/react";
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
