import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Options } from "./Options";

describe("Options", () => {
  it("renders settings controls in skeleton state", () => {
    render(<Options />);

    expect(
      screen.getByRole("heading", { name: "DevRecall Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Enable auto-save")).not.toBeChecked();
  });
});
