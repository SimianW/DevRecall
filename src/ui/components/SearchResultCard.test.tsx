import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PageHit, SearchMatchReason } from "../../shared/types";
import { SearchResultCard } from "./SearchResultCard";

// NOTE: dark mode is media-based (tailwind darkMode: "media"). jsdom cannot
// compute colors or toggle a root `.dark` class, so visual contrast cannot be
// asserted in tests. The assertions below check that `dark:text-*` variant
// classes ARE PRESENT in the DOM — dropping one is a real regression that will
// fail a test. Visual contrast is verified by manual QA in both themes.

function makeHit(overrides: Partial<PageHit> = {}): PageHit {
  return {
    page: {
      id: "01HZ0000000000000000000000",
      url: "https://react.dev/learn",
      title: "Learn React",
      domain: "react.dev",
      sourceType: "official_docs",
      summary: "The official React learning path.",
      topics: ["react"],
      technologies: ["Vite"],
      savedAt: Date.UTC(2026, 4, 31),
      status: "ready",
    },
    bestChunk: {
      text: "React lets you build user interfaces out of components.",
      ordinal: 0,
      highlightedHtml: "React lets you build user interfaces out of <mark>components</mark>.",
    },
    scores: { keyword: 2.1, vector: null, fused: 2.1 },
    matchReason: "keyword",
    ...overrides,
  };
}

describe("SearchResultCard", () => {
  it("uses semantic theme tokens for the search result surface", () => {
    const { container } = render(<SearchResultCard hit={makeHit()} />);

    expect(container.firstChild).toHaveClass(
      "border-default",
      "bg-surface-raised",
      "text-foreground",
    );
    expect(screen.getByText("react")).toHaveClass("border-default/80", "bg-foreground/5");
  });

  it("only shows the delete action when deletion is available", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const { rerender } = render(<SearchResultCard hit={makeHit()} />);

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    rerender(<SearchResultCard hit={makeHit()} onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledWith("01HZ0000000000000000000000");
  });
});

// ── Badge label + dark: variant per matchReason ──────────────────────────────

describe("SearchResultCard badge", () => {
  const cases: Array<[SearchMatchReason, string, string]> = [
    ["keyword", "keyword", "dark:text-emerald-300"],
    ["vector", "matched by meaning", "dark:text-violet-300"],
    ["both", "keyword + meaning", "dark:text-sky-300"],
  ];

  it.each(cases)(
    "matchReason=%s → label=%s and dark: variant %s is present",
    (matchReason, expectedLabel, darkClass) => {
      render(<SearchResultCard hit={makeHit({ matchReason })} />);

      const badge = screen.getByText(expectedLabel);
      expect(badge).toBeInTheDocument();
      // Dropping the dark: variant from the BADGE map is a regression —
      // this assertion catches it even though jsdom never applies dark styles.
      expect(badge).toHaveClass(darkClass);
    },
  );
});

// ── Topic chips conditional rendering ────────────────────────────────────────

describe("SearchResultCard topic chips", () => {
  it("renders topic chips when topics are present", () => {
    render(<SearchResultCard hit={makeHit()} />);
    // makeHit defaults to topics: ["react"]
    expect(screen.getByText("react")).toBeInTheDocument();
  });

  it("renders no topic chips when topics array is empty", () => {
    render(<SearchResultCard hit={makeHit({ page: { ...makeHit().page, topics: [] } })} />);
    // The topic chip for "react" must be absent; the badge "keyword" is still present.
    // We verify no chip-like spans for topics exist by checking the container has
    // neither "react" text nor a chip with those styles.
    expect(screen.queryByText("react")).not.toBeInTheDocument();
  });
});

// ── Delete button wiring ──────────────────────────────────────────────────────

describe("SearchResultCard delete", () => {
  it("calls onDelete with page.id when delete is clicked", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<SearchResultCard hit={makeHit()} onDelete={onDelete} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("01HZ0000000000000000000000");
  });

  it("delete button carries dark:text-red-300 variant class", () => {
    render(<SearchResultCard hit={makeHit()} onDelete={vi.fn()} />);

    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    expect(deleteBtn).toHaveClass("dark:text-red-300");
  });
});

// ── Highlighted HTML rendering ────────────────────────────────────────────────

describe("SearchResultCard highlighted chunk", () => {
  it("renders <mark> elements from highlightedHtml", () => {
    const { container } = render(<SearchResultCard hit={makeHit()} />);

    const mark = container.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("components");
  });
});
