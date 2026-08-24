import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ContentType, Platform } from "../../shared/enums";
import type { PageListItem } from "../../shared/types";
import { PageCard } from "./PageCard";

type CardPage = PageListItem & { excerpt: string };

function makePage(overrides: Partial<CardPage> = {}): CardPage {
  return {
    id: "01HZ0000000000000000000000",
    url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
    title: "Horizontal Pod Autoscaling",
    domain: "kubernetes.io",
    platform: Platform.Web,
    contentType: ContentType.Documentation,
    summary: "Automatically scale workloads based on observed CPU usage.",
    excerpt: "A local excerpt from the saved page.",
    topics: ["autoscaling", "workloads"],
    technologies: ["Kubernetes", "Metrics Server"],
    savedAt: Date.UTC(2026, 4, 16),
    status: "ready",
    ...overrides,
  };
}

describe("PageCard text", () => {
  it("uses an AI summary as the primary card text", () => {
    render(<PageCard page={makePage()} />);
    expect(screen.getByText(/Automatically scale workloads/)).toBeInTheDocument();
    expect(screen.queryByText("A local excerpt from the saved page.")).not.toBeInTheDocument();
  });

  it("labels and displays the excerpt when the summary is empty", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ summary: "" })} />);

    expect(screen.getByText("A local excerpt from the saved page.")).toBeInTheDocument();
    expect(screen.queryByText(makePage().url)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/ }));

    const excerpt = screen.getByRole("heading", { name: "Excerpt" }).parentElement;
    expect(excerpt).not.toBeNull();
    expect(
      within(excerpt as HTMLElement).getByText("A local excerpt from the saved page."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Summary" })).not.toBeInTheDocument();
  });

  it("shows platform, content type, topics, and technologies when expanded", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage()} />);
    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/ }));

    expect(screen.getByRole("heading", { name: "Platform" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByText("Documentation")).toBeInTheDocument();
    expect(screen.getByText("autoscaling")).toBeInTheDocument();
    expect(screen.getByText("Kubernetes")).toBeInTheDocument();
  });
});

describe("PageCard lifecycle labels", () => {
  const cases: Array<[PageListItem["status"], string]> = [
    ["pending", "Saving locally..."],
    ["keyword_ready", "Saved locally"],
    ["enriching", "Adding AI features..."],
    ["ready", "Ready"],
    ["failed", "Local save failed"],
  ];

  it.each(cases)("shows %s as %s", (status, label) => {
    render(<PageCard page={makePage({ status })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("shows enrichment failure without presenting it as a local-save failure", () => {
    render(
      <PageCard
        page={makePage({
          status: "keyword_ready",
          enrichmentError: "OpenAI rate limit exceeded",
        })}
      />,
    );

    expect(
      screen.getByText("AI processing failed: OpenAI rate limit exceeded"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Local save failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry AI features" })).toBeInTheDocument();
  });
});

describe("PageCard AI action", () => {
  it("starts per-page AI features immediately when a key is available", async () => {
    const user = userEvent.setup();
    const onAddAiFeatures = vi.fn();
    render(
      <PageCard
        page={makePage({ status: "keyword_ready" })}
        hasApiKey
        onAddAiFeatures={onAddAiFeatures}
      />,
    );

    expect(
      screen.getByText("Sends this page to OpenAI for a summary, tags, and semantic search."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add AI features" }));
    expect(onAddAiFeatures).toHaveBeenCalledWith(makePage().id);
  });

  it("keeps the action visible but disabled without a key and links to Settings", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <PageCard
        page={makePage({ status: "keyword_ready" })}
        onAddAiFeatures={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByRole("button", { name: "Add AI features" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

describe("PageCard library actions", () => {
  it("wires retry for a local save failure and delete when expanded", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onDelete = vi.fn();
    const page = makePage({ status: "failed" });
    render(<PageCard page={page} onRetry={onRetry} onDelete={onDelete} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/ }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onRetry).toHaveBeenCalledWith(page.id);
    expect(onDelete).toHaveBeenCalledWith(page.id);
  });
});
