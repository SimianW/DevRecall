import type { ManualSaveResult } from "../shared/messages";

const MANUAL_SAVE_RESULT_COPY: Record<ManualSaveResult, string> = {
  saved: "Saved to DevRecall",
  already_saved: "Already saved",
  failed: "Couldn’t save this page",
};

type ActiveNotification = {
  host: HTMLElement;
  timeout: ReturnType<typeof setTimeout>;
};

const activeNotifications = new WeakMap<Document, ActiveNotification>();

export function showManualSaveResult(result: ManualSaveResult, doc: Document = document): void {
  const previous = activeNotifications.get(doc);
  if (previous) {
    clearTimeout(previous.timeout);
    previous.host.remove();
  }

  const host = doc.createElement("div");
  host.dataset.devrecallSaveResult = "";
  Object.assign(host.style, {
    position: "fixed",
    top: "16px",
    left: "16px",
    zIndex: "2147483647",
    pointerEvents: "none",
  });

  const root = host.attachShadow({ mode: "open" });
  const notification = doc.createElement("div");
  notification.setAttribute("role", result === "failed" ? "alert" : "status");
  notification.textContent = MANUAL_SAVE_RESULT_COPY[result];
  Object.assign(notification.style, {
    boxSizing: "border-box",
    maxWidth: "min(320px, calc(100vw - 32px))",
    padding: "10px 14px",
    border: "1px solid rgba(255, 255, 255, 0.2)",
    borderRadius: "8px",
    background: result === "failed" ? "#991b1b" : "#1f2937",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.24)",
    color: "#ffffff",
    font: '500 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });

  root.append(notification);
  doc.documentElement.append(host);

  const active: ActiveNotification = {
    host,
    timeout: setTimeout(() => {
      host.remove();
      if (activeNotifications.get(doc) === active) {
        activeNotifications.delete(doc);
      }
    }, 3_000),
  };
  activeNotifications.set(doc, active);
}
