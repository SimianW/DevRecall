import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Popup } from "./Popup";

describe("Popup", () => {
  it("disables save when no API key is set", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(false);
    render(<Popup saveCurrentPage={vi.fn()} checkApiKey={checkApiKey} />);

    expect(await screen.findByText("Set API key in settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save this page" })).toBeDisabled();
  });

  it("enables save when API key is set", async () => {
    const checkApiKey = vi.fn().mockResolvedValue(true);
    render(<Popup saveCurrentPage={vi.fn()} checkApiKey={checkApiKey} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this page" })).toBeEnabled();
    });
    expect(screen.queryByText("Set API key in settings")).not.toBeInTheDocument();
  });

  it("saves the current page and shows a saved state", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockResolvedValue(undefined);
    const checkApiKey = vi.fn().mockResolvedValue(true);

    render(<Popup saveCurrentPage={saveCurrentPage} checkApiKey={checkApiKey} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this page" })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(saveCurrentPage).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Saved" })).toBeEnabled();
  });

  it("shows an error state when save fails", async () => {
    const user = userEvent.setup();
    const saveCurrentPage = vi.fn().mockRejectedValue(new Error("no tab"));
    const checkApiKey = vi.fn().mockResolvedValue(true);

    render(<Popup saveCurrentPage={saveCurrentPage} checkApiKey={checkApiKey} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this page" })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: "Save this page" }));

    expect(await screen.findByText("Failed to save page")).toBeInTheDocument();
  });

  it("opens the side panel through the injected callback", async () => {
    const user = userEvent.setup();
    const openSidePanel = vi.fn();
    const checkApiKey = vi.fn().mockResolvedValue(true);

    render(
      <Popup
        openSidePanel={openSidePanel}
        saveCurrentPage={vi.fn()}
        checkApiKey={checkApiKey}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open library" }));

    expect(openSidePanel).toHaveBeenCalledTimes(1);
  });
});
