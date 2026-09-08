import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContentType, Platform } from "../shared/enums";
import { ImportBackup } from "./ImportBackup";

function backupFile(json?: string) {
  const text =
    json ??
    JSON.stringify({
      schemaVersion: 1,
      pages: [
        {
          url: "https://example.com",
          title: "Guide",
          fullText: "Useful guide",
          summary: "",
          topics: [],
          technologies: [],
          platform: Platform.Web,
          contentType: ContentType.Page,
          intent: "reference",
          savedAt: 1,
          visitedAt: 1,
          readingTimeMs: 0,
          saveMode: "manual",
        },
      ],
    });
  const file = new File([text], "backup.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve(text) });
  return file;
}

describe("ImportBackup", () => {
  it("previews the file and waits for confirmation before restoring", async () => {
    const user = userEvent.setup();
    const importData = vi.fn().mockResolvedValue({ imported: 1, skipped: 0 });
    const onImported = vi.fn();
    render(<ImportBackup importData={importData} onImported={onImported} />);
    await user.upload(screen.getByLabelText("Choose DevRecall backup"), backupFile());
    expect(await screen.findByText("backup.json: 1 page ready to import.")).toBeInTheDocument();
    expect(importData).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm import" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Imported 1 page. Skipped 0 duplicates.",
    );
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("rejects an invalid backup without calling the worker", async () => {
    const user = userEvent.setup();
    const importData = vi.fn();
    render(<ImportBackup importData={importData} onImported={vi.fn()} />);
    await user.upload(screen.getByLabelText("Choose DevRecall backup"), backupFile("{}"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a supported DevRecall backup");
    expect(importData).not.toHaveBeenCalled();
  });

  it("preserves the confirmation after failure so the user can retry", async () => {
    const user = userEvent.setup();
    const importData = vi
      .fn()
      .mockRejectedValueOnce(new Error("Storage full"))
      .mockResolvedValueOnce({ imported: 0, skipped: 1 });
    render(<ImportBackup importData={importData} onImported={vi.fn()} />);
    await user.upload(screen.getByLabelText("Choose DevRecall backup"), backupFile());
    await user.click(await screen.findByRole("button", { name: "Confirm import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage full");
    await user.click(screen.getByRole("button", { name: "Confirm import" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Skipped 1 duplicate.");
  });
});
