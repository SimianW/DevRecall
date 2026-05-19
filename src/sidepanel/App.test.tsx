import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PageListItem } from "../shared/types";
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

describe("Side panel app", () => {
  it("renders the library search shell", async () => {
    render(<App listPages={vi.fn().mockResolvedValue([])} />);

    expect(
      screen.getByRole("heading", { name: "DevRecall" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search saved pages" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("No saved pages yet")).toBeInTheDocument();
  });

  it("lists saved pages from the worker", async () => {
    const listPages = vi.fn().mockResolvedValue(pages);

    render(<App listPages={listPages} />);

    expect(listPages).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", {
        name: "Horizontal Pod Autoscaling",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("kubernetes.io")).toBeInTheDocument();
  });
});
