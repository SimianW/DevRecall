import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SurfaceShell } from "./SurfaceShell";

describe("SurfaceShell", () => {
  it("renders a titled extension surface", () => {
    render(
      <SurfaceShell title="DevRecall">
        <p>Ready</p>
      </SurfaceShell>,
    );

    expect(
      screen.getByRole("heading", { name: "DevRecall" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("renders optional actions", () => {
    render(
      <SurfaceShell
        title="DevRecall"
        actions={<button type="button">Settings</button>}
      >
        <p>Ready</p>
      </SurfaceShell>,
    );

    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
  });
});
