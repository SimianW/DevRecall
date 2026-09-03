import { afterEach, describe, expect, it, vi } from "vitest";

import { showManualSaveResult } from "./manualSaveNotification";

afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll("[data-devrecall-save-result]").forEach((element) => element.remove());
});

describe("manual save result notification", () => {
  it("shows an isolated, non-interactive success status in the top-left corner", () => {
    showManualSaveResult("saved", document);

    const host = document.querySelector("[data-devrecall-save-result]") as HTMLElement;
    const notification = host.shadowRoot?.querySelector('[role="status"]');
    expect(notification).toHaveTextContent("Saved to DevRecall");
    expect(host.style.position).toBe("fixed");
    expect(host.style.top).toBe("16px");
    expect(host.style.left).toBe("16px");
    expect(host.style.pointerEvents).toBe("none");
    expect(document.activeElement).toBe(document.body);
  });

  it("replaces the previous result and removes the latest one after three seconds", () => {
    vi.useFakeTimers();

    showManualSaveResult("already_saved", document);
    expect(
      document
        .querySelector("[data-devrecall-save-result]")
        ?.shadowRoot?.querySelector('[role="status"]'),
    ).toHaveTextContent("Already saved");

    showManualSaveResult("failed", document);
    const hosts = document.querySelectorAll("[data-devrecall-save-result]");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.shadowRoot?.querySelector('[role="alert"]')).toHaveTextContent(
      "Couldn’t save this page",
    );

    vi.advanceTimersByTime(2_999);
    expect(document.querySelector("[data-devrecall-save-result]")).toBeInTheDocument();
    vi.advanceTimersByTime(1);
    expect(document.querySelector("[data-devrecall-save-result]")).not.toBeInTheDocument();
  });
});
