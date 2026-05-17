import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("Side panel app", () => {
  it("renders the library search shell", () => {
    render(<App />);

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
    expect(screen.getByText("No saved pages yet")).toBeInTheDocument();
  });
});
