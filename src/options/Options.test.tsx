import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Options } from "./Options";

const renderOptions = (props: Partial<React.ComponentProps<typeof Options>> = {}) => {
  const defaultProps = {
    loadStatus: vi.fn().mockResolvedValue({ hasApiKey: false }),
    saveApiKey: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ success: true, message: "Connection successful" }),
    ...props,
  };
  
  return {
    ...render(<Options {...defaultProps} />),
    props: defaultProps,
    user: userEvent.setup(),
  };
};

describe("Options", () => {
  it("renders the settings form", async () => {
    renderOptions();

    expect(screen.getByRole("heading", { name: "DevRecall Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();
    
    // Save button should be present and disabled
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    
    // Test connection button present (also disabled initially)
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
  });

  it("enables save button when API key is entered", async () => {
    const { user } = renderOptions();
    
    const input = screen.getByLabelText("OpenAI API key");
    const saveButton = screen.getByRole("button", { name: "Save" });
    
    expect(saveButton).toBeDisabled();
    await user.type(input, "sk-test-123");
    expect(saveButton).toBeEnabled();
  });

  it("saves an API key", async () => {
    const { user, props } = renderOptions();
    
    const input = screen.getByLabelText("OpenAI API key");
    const saveButton = screen.getByRole("button", { name: "Save" });
    
    await user.type(input, "sk-test-123");
    await user.click(saveButton);
    
    expect(props.saveApiKey).toHaveBeenCalledWith("sk-test-123");
    
    // test connection should now be enabled
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });

  it("tests connection and shows success", async () => {
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
    });
    
    // Wait for the loadStatus to resolve and enable the button
    const testButton = await screen.findByRole("button", { name: "Test connection" });
    expect(testButton).toBeEnabled();
    
    await user.click(testButton);
    
    const message = await screen.findByText("Connection successful");
    expect(message).toBeInTheDocument();
    expect(message).toHaveClass("text-green-600");
  });

  it("shows error when connection test fails", async () => {
    const { user } = renderOptions({
      loadStatus: vi.fn().mockResolvedValue({ hasApiKey: true }),
      testConnection: vi.fn().mockResolvedValue({ success: false, message: "Invalid API key" }),
    });
    
    const testButton = await screen.findByRole("button", { name: "Test connection" });
    await user.click(testButton);
    
    const message = await screen.findByText("Invalid API key");
    expect(message).toBeInTheDocument();
    expect(message).toHaveClass("text-red-600");
  });
});
