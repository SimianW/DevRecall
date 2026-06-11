import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkerBroadcast } from "../shared/messages";
import type { PageHit, PageListItem } from "../shared/types";
import { App } from "./App";

function makeSubscribe() {
  let handler: ((message: WorkerBroadcast) => void) | null = null;
  const subscribe = (h: (message: WorkerBroadcast) => void) => {
    handler = h;
    return () => {
      handler = null;
    };
  };
  const emit = async (message: WorkerBroadcast) => {
    await act(async () => {
      handler?.(message);
    });
  };
  return { subscribe, emit };
}

const pages = [
  {
    id: "01HZ0000000000000000000000",
    url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
    title: "Horizontal Pod Autoscaling",
    domain: "kubernetes.io",
    sourceType: "unknown",
    summary: "",
    topics: [],
    technologies: [],
    savedAt: 100,
    status: "ready",
  },
] satisfies PageListItem[];

const hits = [
  {
    page: pages[0],
    bestChunk: {
      text: "The HorizontalPodAutoscaler automatically scales pods.",
      ordinal: 0,
      highlightedHtml: "The HorizontalPodAutoscaler automatically scales <mark>pods</mark>.",
    },
    scores: { keyword: 2.1, vector: null, fused: 2.1 },
    matchReason: "keyword",
  },
] satisfies PageHit[];

const newPage: PageListItem = {
  id: "01HZ1111111111111111111111",
  url: "https://react.dev/learn",
  title: "Learn React",
  domain: "react.dev",
  sourceType: "official_docs",
  summary: "React docs",
  topics: [],
  technologies: [],
  savedAt: 200,
  status: "ready",
};

describe("Side panel app", () => {
  it("renders the library search shell", async () => {
    render(<App listPages={vi.fn().mockResolvedValue([])} runSearch={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "DevRecall" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search saved pages" })).toHaveClass(
      "border-default",
      "bg-surface-raised",
      "text-foreground",
    );
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("No saved pages yet")).toBeInTheDocument();
  });

  it("lists saved pages from the worker", async () => {
    const listPages = vi.fn().mockResolvedValue(pages);

    render(<App listPages={listPages} runSearch={vi.fn()} />);

    expect(listPages).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", {
        name: "Horizontal Pod Autoscaling",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("kubernetes.io")).toBeInTheDocument();
  });

  it("runs a keyword search and shows highlighted results", async () => {
    const user = userEvent.setup();
    const runSearch = vi.fn().mockResolvedValue(hits);

    render(<App listPages={vi.fn().mockResolvedValue([])} runSearch={runSearch} />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search saved pages" }),
      "autoscale pods",
    );

    expect(
      await screen.findByRole("heading", {
        name: "Horizontal Pod Autoscaling",
      }),
    ).toBeInTheDocument();
    expect(runSearch).toHaveBeenCalledWith("autoscale pods");
    expect(screen.getByText("keyword")).toBeInTheDocument();
  });

  it("filters search results when a source chip is active", async () => {
    const user = userEvent.setup();
    const runSearch = vi.fn().mockResolvedValue([
      hits[0],
      {
        ...hits[0],
        page: {
          ...hits[0].page,
          id: "01HZ0000000000000000000004",
          title: "Stack Overflow Result",
          domain: "stackoverflow.com",
          url: "https://stackoverflow.com/questions/123",
          sourceType: "stackoverflow",
        },
      },
    ]);

    render(<App listPages={vi.fn().mockResolvedValue([])} runSearch={runSearch} />);

    await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "autoscale");
    await screen.findByRole("heading", { name: "Horizontal Pod Autoscaling" });

    await user.click(screen.getByRole("button", { name: "Stack Overflow" }));

    expect(screen.queryByRole("heading", { name: "Horizontal Pod Autoscaling" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Stack Overflow Result" })).toBeInTheDocument();
  });

  it("shows an empty-search message when nothing matches", async () => {
    const user = userEvent.setup();
    const runSearch = vi.fn().mockResolvedValue([]);

    render(<App listPages={vi.fn().mockResolvedValue([])} runSearch={runSearch} />);

    await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "nomatch");

    expect(await screen.findByText("No matches for your search")).toBeInTheDocument();
  });
});

describe("Side panel live refresh", () => {
  it("inserts a card when a page.updated broadcast arrives", async () => {
    const { subscribe, emit } = makeSubscribe();
    render(
      <App listPages={vi.fn().mockResolvedValue([])} runSearch={vi.fn()} subscribe={subscribe} />,
    );

    await screen.findByText("No saved pages yet");
    await emit({ type: "page.updated", payload: { page: newPage } });

    expect(await screen.findByRole("heading", { name: "Learn React" })).toBeInTheDocument();
  });

  it("removes a card when a page.removed broadcast arrives", async () => {
    const { subscribe, emit } = makeSubscribe();
    render(
      <App
        listPages={vi.fn().mockResolvedValue(pages)}
        runSearch={vi.fn()}
        subscribe={subscribe}
      />,
    );

    await screen.findByRole("heading", { name: "Horizontal Pod Autoscaling" });
    await emit({ type: "page.removed", payload: { id: pages[0].id } });

    expect(screen.queryByRole("heading", { name: "Horizontal Pod Autoscaling" })).toBeNull();
  });

  it("clears the library when a library.cleared broadcast arrives", async () => {
    const { subscribe, emit } = makeSubscribe();
    render(
      <App
        listPages={vi.fn().mockResolvedValue(pages)}
        runSearch={vi.fn()}
        subscribe={subscribe}
      />,
    );

    await screen.findByRole("heading", { name: "Horizontal Pod Autoscaling" });
    await emit({ type: "library.cleared" });

    expect(screen.queryByRole("heading", { name: "Horizontal Pod Autoscaling" })).toBeNull();
    expect(screen.getByText("No saved pages yet")).toBeInTheDocument();
  });

  it("resets search mode when a library.cleared broadcast arrives during an active query", async () => {
    const { subscribe, emit } = makeSubscribe();
    const user = userEvent.setup();
    render(
      <App
        listPages={vi.fn().mockResolvedValue(pages)}
        runSearch={vi.fn().mockResolvedValue(hits)}
        subscribe={subscribe}
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "autoscale");
    await screen.findByRole("heading", { name: "Horizontal Pod Autoscaling" });

    await emit({ type: "library.cleared" });

    expect(screen.getByRole("searchbox", { name: "Search saved pages" })).toHaveValue("");
    expect(screen.queryByRole("heading", { name: "Horizontal Pod Autoscaling" })).toBeNull();
    expect(screen.getByText("No saved pages yet")).toBeInTheDocument();
  });

  it("deletes a page from the expanded card", async () => {
    const user = userEvent.setup();
    const deletePage = vi.fn().mockResolvedValue(undefined);
    render(
      <App
        listPages={vi.fn().mockResolvedValue(pages)}
        runSearch={vi.fn()}
        deletePage={deletePage}
        subscribe={makeSubscribe().subscribe}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Horizontal Pod Autoscaling/ }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(deletePage).toHaveBeenCalledWith(pages[0].id);
  });
});

const vectorHit = {
  page: pages[0],
  bestChunk: {
    text: "The HorizontalPodAutoscaler automatically scales workloads.",
    ordinal: 0,
    highlightedHtml: "The HorizontalPodAutoscaler automatically scales workloads.",
  },
  scores: { keyword: null, vector: 0.83, fused: 0.016 },
  matchReason: "vector",
} satisfies PageHit;

it("labels a vector-only hit as matched by meaning", async () => {
  const user = userEvent.setup();
  const runSearch = vi.fn().mockResolvedValue([vectorHit]);

  render(
    <App
      listPages={vi.fn().mockResolvedValue([])}
      runSearch={runSearch}
      subscribe={makeSubscribe().subscribe}
    />,
  );

  await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "elastic scaling");

  expect(await screen.findByText("matched by meaning")).toBeInTheDocument();
});

describe("Filter chip wiring", () => {
  const mixedPages: PageListItem[] = [
    {
      id: "01HZ0000000000000000000001",
      url: "https://kubernetes.io/docs/",
      title: "Kubernetes Docs",
      domain: "kubernetes.io",
      sourceType: "official_docs",
      summary: "",
      topics: [],
      technologies: [],
      savedAt: 100,
      status: "ready",
    },
    {
      id: "01HZ0000000000000000000002",
      url: "https://stackoverflow.com/questions/123",
      title: "Stack Overflow Q",
      domain: "stackoverflow.com",
      sourceType: "stackoverflow",
      summary: "",
      topics: [],
      technologies: [],
      savedAt: 200,
      status: "ready",
    },
    {
      id: "01HZ0000000000000000000003",
      url: "https://github.com/kubernetes/kubernetes/issues/1",
      title: "GitHub Issue",
      domain: "github.com",
      sourceType: "github_issue",
      summary: "",
      topics: [],
      technologies: [],
      savedAt: 300,
      status: "ready",
    },
  ];

  it("shows all pages when 'All' chip is active", async () => {
    render(<App listPages={vi.fn().mockResolvedValue(mixedPages)} runSearch={vi.fn()} />);

    expect(await screen.findByText("Kubernetes Docs")).toBeInTheDocument();
    expect(screen.getByText("Stack Overflow Q")).toBeInTheDocument();
    expect(screen.getByText("GitHub Issue")).toBeInTheDocument();
  });

  it("filters to official_docs when 'Docs' chip is clicked", async () => {
    const user = userEvent.setup();
    render(<App listPages={vi.fn().mockResolvedValue(mixedPages)} runSearch={vi.fn()} />);

    await screen.findByText("Kubernetes Docs");

    await user.click(screen.getByRole("button", { name: "Docs" }));
    expect(screen.getByRole("button", { name: "Docs" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Kubernetes Docs")).toBeInTheDocument();
    expect(screen.queryByText("Stack Overflow Q")).toBeNull();
    expect(screen.queryByText("GitHub Issue")).toBeNull();
  });

  it("filters to stackoverflow when 'Stack Overflow' chip is clicked", async () => {
    const user = userEvent.setup();
    render(<App listPages={vi.fn().mockResolvedValue(mixedPages)} runSearch={vi.fn()} />);

    await screen.findByText("Stack Overflow Q");

    await user.click(screen.getByRole("button", { name: "Stack Overflow" }));
    expect(screen.queryByText("Kubernetes Docs")).toBeNull();
    expect(screen.getByText("Stack Overflow Q")).toBeInTheDocument();
    expect(screen.queryByText("GitHub Issue")).toBeNull();
  });

  it("filters to github_issue when 'GitHub' chip is clicked", async () => {
    const user = userEvent.setup();
    render(<App listPages={vi.fn().mockResolvedValue(mixedPages)} runSearch={vi.fn()} />);

    await screen.findByText("GitHub Issue");

    await user.click(screen.getByRole("button", { name: "GitHub" }));
    expect(screen.queryByText("Kubernetes Docs")).toBeNull();
    expect(screen.queryByText("Stack Overflow Q")).toBeNull();
    expect(screen.getByText("GitHub Issue")).toBeInTheDocument();
  });

  it("returns to all pages when 'All' chip is clicked after filtering", async () => {
    const user = userEvent.setup();
    render(<App listPages={vi.fn().mockResolvedValue(mixedPages)} runSearch={vi.fn()} />);

    await screen.findByText("Kubernetes Docs");
    await user.click(screen.getByRole("button", { name: "Docs" }));
    expect(screen.queryByText("Stack Overflow Q")).toBeNull();

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Kubernetes Docs")).toBeInTheDocument();
    expect(screen.getByText("Stack Overflow Q")).toBeInTheDocument();
    expect(screen.getByText("GitHub Issue")).toBeInTheDocument();
  });
});

describe("Retry failed pages in side panel", () => {
  const failedPage: PageListItem = {
    id: "01HZ0000000000000000000099",
    url: "https://example.com/failed",
    title: "Failed Page",
    domain: "example.com",
    sourceType: "unknown",
    summary: "",
    topics: [],
    technologies: [],
    savedAt: 100,
    status: "failed",
  };

  it("shows a Retry button on a failed page card when expanded", async () => {
    const user = userEvent.setup();
    render(<App listPages={vi.fn().mockResolvedValue([failedPage])} runSearch={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Failed Page/ }));
    expect(await screen.findByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });

  it("calls retryPage with the page id when Retry is clicked", async () => {
    const user = userEvent.setup();
    const retryPage = vi.fn().mockResolvedValue(undefined);
    render(
      <App
        listPages={vi.fn().mockResolvedValue([failedPage])}
        runSearch={vi.fn()}
        retryPage={retryPage}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Failed Page/ }));
    await user.click(await screen.findByRole("button", { name: /Retry/i }));

    expect(retryPage).toHaveBeenCalledWith(failedPage.id);
  });
});

it("can delete a page from a search result card", async () => {
  const user = userEvent.setup();
  const deletePage = vi.fn().mockResolvedValue(undefined);
  const runSearch = vi.fn().mockResolvedValue([vectorHit]);

  render(
    <App
      listPages={vi.fn().mockResolvedValue([])}
      runSearch={runSearch}
      deletePage={deletePage}
      subscribe={makeSubscribe().subscribe}
    />,
  );

  await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "elastic scaling");
  await user.click(await screen.findByRole("button", { name: "Delete" }));

  expect(deletePage).toHaveBeenCalledWith(pages[0].id);
});
