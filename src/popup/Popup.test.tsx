import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Popup } from "./Popup";

describe("Popup", () => {
  it("enables manual save without requiring an API key", () => {
    render(<Popup saveCurrentPage={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "DevRecall" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save this page" }),
    ).toBeEnabled();
    expect(screen.queryByText("Set API key in settings")).not.toBeInTheDocument();
  });

  it("saves the current page and shows a saved state", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockResolvedValue(undefined);

    render(<Popup saveCurrentPage={saveCurrentPage} />);

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(saveCurrentPage).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Saved" })).toBeEnabled();
  });

  it("shows saving state while the save is in flight", async () => {
    const user = userEvent.setup();
    let resolveSave: () => void;
    const saveCurrentPage = vi
      .fn()
      .mockImplementation(
        () => new Promise<void>((resolve) => { resolveSave = resolve; }),
      );

    render(<Popup saveCurrentPage={saveCurrentPage} />);

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(
      screen.getByRole("button", { name: "Saving..." }),
    ).toBeDisabled();
    expect(saveCurrentPage).toHaveBeenCalledTimes(1);

    resolveSave!();
    expect(await screen.findByRole("button", { name: "Saved" })).toBeEnabled();
  });

  it("shows an error state when save fails", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockRejectedValue(new Error("no tab"));

    render(<Popup saveCurrentPage={saveCurrentPage} />);

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(await screen.findByText("Failed to save page")).toBeInTheDocument();
  });

  it("opens the side panel through the injected callback", async () => {
    const user = userEvent.setup();
    const openSidePanel = vi.fn();

    render(<Popup openSidePanel={openSidePanel} saveCurrentPage={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Open library" }));

    expect(openSidePanel).toHaveBeenCalledTimes(1);
  });
});
