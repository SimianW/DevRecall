import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PageListItem } from "../../shared/types";
import { PageCard } from "./PageCard";

// NOTE: dark mode is media-based (tailwind darkMode: "media"). jsdom cannot
// compute colors or toggle a root `.dark` class, so visual contrast cannot be
// asserted in tests. The assertions below check that `dark:text-*` variant
// classes ARE PRESENT in the DOM — dropping one is a real regression that will
// fail a test. Visual contrast is verified by manual QA in both themes.

function makePage(overrides: Partial<PageListItem> = {}): PageListItem {
  return {
    id: "01HZ0000000000000000000000",
    url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
    title: "Horizontal Pod Autoscaling",
    domain: "kubernetes.io",
    sourceType: "official_docs",
    summary: "Automatically scale workloads based on observed CPU usage.",
    topics: ["autoscaling", "workloads"],
    technologies: ["Kubernetes", "Metrics Server"],
    savedAt: Date.UTC(2026, 4, 16),
    status: "ready",
    ...overrides,
  };
}

describe("PageCard", () => {
  it("shows a summary section with the URL fallback and hides empty detail groups", async () => {
    const user = userEvent.setup();
    render(
      <PageCard
        page={makePage({
          summary: "",
          topics: [],
          technologies: [],
          sourceType: "unknown",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    const summaryGroup = screen.getByRole("heading", { name: "Summary" }).parentElement;
    expect(summaryGroup).not.toBeNull();

    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(
      within(summaryGroup as HTMLElement).getByText(
        "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Topics")).not.toBeInTheDocument();
    expect(screen.queryByText("Technologies")).not.toBeInTheDocument();
  });

  it("renders labeled topic and technology groups when metadata exists", async () => {
    const user = userEvent.setup();
    const { container } = render(<PageCard page={makePage()} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    expect(container.firstChild).toHaveClass(
      "border-default",
      "bg-surface-raised",
      "text-foreground",
    );
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Topics")).toBeInTheDocument();
    expect(screen.getByText("Technologies")).toBeInTheDocument();
    expect(screen.getByText("autoscaling")).toBeInTheDocument();
    expect(screen.getByText("workloads")).toBeInTheDocument();
    expect(screen.getByText("Kubernetes")).toBeInTheDocument();
    expect(screen.getByText("Metrics Server")).toBeInTheDocument();
  });

  it("does not show retry for ready pages", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<PageCard page={makePage()} onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("shows a processing badge for pending pages and still hides retry", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ status: "pending" })} onRetry={vi.fn()} />);

    expect(screen.getByText("Processing...")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows retry for failed pages and wires the retry action", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<PageCard page={makePage({ status: "failed" })} onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledWith("01HZ0000000000000000000000");
  });

  it("only shows delete when deletion is available", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const { rerender } = render(<PageCard page={makePage()} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    rerender(<PageCard page={makePage()} onDelete={onDelete} />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledWith("01HZ0000000000000000000000");
  });
});

// ── Collapsed vs expanded — detail sections are gated ────────────────────────

describe("PageCard collapsed vs expanded", () => {
  it("does not render detail sections when collapsed", () => {
    render(<PageCard page={makePage()} />);

    // Summary / Topics / Technologies headings only appear when expanded.
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Topics")).not.toBeInTheDocument();
    expect(screen.queryByText("Technologies")).not.toBeInTheDocument();
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("reveals detail sections after expanding", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage()} onDelete={vi.fn()} />);

    // Verify collapsed state first
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    // All detail group headings now visible
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Topics")).toBeInTheDocument();
    expect(screen.getByText("Technologies")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    // Actions appear only when expanded
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("hides detail sections again after collapsing", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage()} />);

    const toggle = screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i });
    await user.click(toggle);
    expect(screen.getByText("Summary")).toBeInTheDocument();

    // Collapse again
    await user.click(toggle);
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
  });

  it("summary uses URL as fallback when page summary is empty", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ summary: "" })} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    const summaryHeading = screen.getByRole("heading", { name: "Summary" });
    const summarySection = summaryHeading.parentElement as HTMLElement;
    expect(
      within(summarySection).getByText(
        "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      ),
    ).toBeInTheDocument();
  });
});

// ── Retry affordance — status gates ──────────────────────────────────────────

describe("PageCard retry affordance per status", () => {
  it("retry button absent for status=ready (even with onRetry prop)", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ status: "ready" })} onRetry={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("retry button absent for status=pending (even with onRetry prop)", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ status: "pending" })} onRetry={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("retry button visible ONLY for status=failed", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ status: "failed" })} onRetry={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retry button absent when status=failed but onRetry prop is not provided", async () => {
    const user = userEvent.setup();
    // No onRetry prop: the button is only rendered when the callback is supplied.
    render(<PageCard page={makePage({ status: "failed" })} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

// ── errorReason in expanded failed view ──────────────────────────────────────

describe("PageCard errorReason display", () => {
  it("shows the errorReason text in the expanded detail view when status=failed and errorReason is present", async () => {
    const user = userEvent.setup();
    render(
      <PageCard page={makePage({ status: "failed", errorReason: "OpenAI rate limit exceeded" })} />,
    );

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    expect(screen.getByText("OpenAI rate limit exceeded")).toBeInTheDocument();
  });

  it("does not show errorReason text when status=ready even if errorReason is somehow present", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ status: "ready", errorReason: "stale error" })} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    expect(screen.queryByText("stale error")).not.toBeInTheDocument();
  });

  it("errorReason carries dark:text-red-300 variant class", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ status: "failed", errorReason: "Connection timed out" })} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    const errorEl = screen.getByText("Connection timed out");
    expect(errorEl).toHaveClass("dark:text-red-300");
  });
});

// ── Status badges and dark: variant classes ───────────────────────────────────

describe("PageCard status badges dark: variants", () => {
  it("failed badge carries dark:text-red-300", () => {
    render(<PageCard page={makePage({ status: "failed" })} />);

    const badge = screen.getByText("Failed");
    expect(badge).toHaveClass("dark:text-red-300");
  });

  it("pending badge carries dark:text-amber-300", () => {
    render(<PageCard page={makePage({ status: "pending" })} />);

    const badge = screen.getByText("Processing...");
    expect(badge).toHaveClass("dark:text-amber-300");
  });

  it("retry button carries dark:text-amber-300 variant when visible", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage({ status: "failed" })} onRetry={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toHaveClass("dark:text-amber-300");
  });

  it("delete button carries dark:text-red-300 variant when visible", async () => {
    const user = userEvent.setup();
    render(<PageCard page={makePage()} onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Horizontal Pod Autoscaling/i }));

    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    expect(deleteBtn).toHaveClass("dark:text-red-300");
  });

  it("ready status renders no status badge (StatusBadge returns null)", () => {
    render(<PageCard page={makePage({ status: "ready" })} />);

    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Processing...")).not.toBeInTheDocument();
  });
});
