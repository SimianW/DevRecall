import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PageHit, PageListItem } from "../shared/types";
import { App } from "./App";

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

describe("Side panel app", () => {
  it("renders the library search shell", async () => {
    render(<App listPages={vi.fn().mockResolvedValue([])} runSearch={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "DevRecall" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search saved pages" })).toBeInTheDocument();
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

  it("shows an empty-search message when nothing matches", async () => {
    const user = userEvent.setup();
    const runSearch = vi.fn().mockResolvedValue([]);

    render(<App listPages={vi.fn().mockResolvedValue([])} runSearch={runSearch} />);

    await user.type(screen.getByRole("searchbox", { name: "Search saved pages" }), "nomatch");

    expect(await screen.findByText("No matches for your search")).toBeInTheDocument();
  });
});
