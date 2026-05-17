import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Popup } from "./Popup";

describe("Popup", () => {
  it("shows the save entry point in disabled skeleton state", () => {
    render(<Popup />);

    expect(
      screen.getByRole("heading", { name: "DevRecall" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save this page" }),
    ).toBeDisabled();
    expect(screen.getByText("Set API key in settings")).toBeInTheDocument();
  });

  it("opens the side panel through the injected callback", async () => {
    const user = userEvent.setup();
    const openSidePanel = vi.fn();

    render(<Popup openSidePanel={openSidePanel} />);

    await user.click(screen.getByRole("button", { name: "Open library" }));

    expect(openSidePanel).toHaveBeenCalledTimes(1);
  });
});
