import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRequest, sendRequestOrThrow, subscribeToBroadcasts } from "./rpc";

type ChromeStub = {
  runtime?: {
    sendMessage?: (message: unknown) => Promise<unknown>;
    onMessage?: {
      addListener: (listener: (message: unknown) => void) => void;
      removeListener: (listener: (message: unknown) => void) => void;
    };
  };
};

function installChrome(stub: ChromeStub) {
  (globalThis as { chrome?: ChromeStub }).chrome = stub;
}

afterEach(() => {
  delete (globalThis as { chrome?: ChromeStub }).chrome;
});

describe("sendRequest", () => {
  it("returns null when chrome.runtime is unavailable", async () => {
    const result = await sendRequest({ type: "devrecall.ping" }, "devrecall.pong");
    expect(result).toBeNull();
  });

  it("returns the typed response when the type matches", async () => {
    const response = {
      type: "page.listed",
      payload: { pages: [] },
    };
    const sendMessage = vi.fn().mockResolvedValue(response);
    installChrome({ runtime: { sendMessage } });

    const result = await sendRequest({ type: "page.list", payload: { limit: 50 } }, "page.listed");

    expect(sendMessage).toHaveBeenCalledWith({ type: "page.list", payload: { limit: 50 } });
    expect(result).toEqual(response);
  });

  it("returns null when the response type does not match", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ type: "error", payload: { message: "boom" } });
    installChrome({ runtime: { sendMessage } });

    const result = await sendRequest({ type: "page.list", payload: { limit: 50 } }, "page.listed");

    expect(result).toBeNull();
  });

  it("returns null when sendMessage rejects", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("no receiver"));
    installChrome({ runtime: { sendMessage } });

    const result = await sendRequest({ type: "devrecall.ping" }, "devrecall.pong");

    expect(result).toBeNull();
  });
});

describe("sendRequestOrThrow", () => {
  it("returns the typed response when the type matches", async () => {
    const response = { type: "data.exported", payload: { json: "{}" } };
    installChrome({ runtime: { sendMessage: vi.fn().mockResolvedValue(response) } });

    await expect(sendRequestOrThrow({ type: "data.export" }, "data.exported")).resolves.toEqual(
      response,
    );
  });

  it("rejects with the worker's message when the worker answers with an error", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ type: "error", payload: { message: "IndexedDB is closed" } });
    installChrome({ runtime: { sendMessage } });

    await expect(sendRequestOrThrow({ type: "data.export" }, "data.exported")).rejects.toThrow(
      "IndexedDB is closed",
    );
  });

  it("rejects when the worker gives no response or a mismatched one", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ type: "page.listed", payload: { pages: [] } });
    installChrome({ runtime: { sendMessage } });

    await expect(sendRequestOrThrow({ type: "data.deleteAll" }, "data.deletedAll")).rejects.toThrow(
      "DevRecall did not respond",
    );
    await expect(sendRequestOrThrow({ type: "data.deleteAll" }, "data.deletedAll")).rejects.toThrow(
      "DevRecall did not respond",
    );
  });

  it("rejects when the channel rejects", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("Message length exceeded maximum"));
    installChrome({ runtime: { sendMessage } });

    await expect(sendRequestOrThrow({ type: "data.export" }, "data.exported")).rejects.toThrow(
      "Message length exceeded maximum",
    );
  });

  it("rejects when chrome.runtime is unavailable", async () => {
    await expect(sendRequestOrThrow({ type: "data.export" }, "data.exported")).rejects.toThrow(
      "DevRecall is unavailable",
    );
  });
});

describe("subscribeToBroadcasts", () => {
  it("returns a noop unsubscribe when chrome.runtime is unavailable", () => {
    const unsubscribe = subscribeToBroadcasts(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it("registers a listener and removes it on unsubscribe", () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    installChrome({ runtime: { onMessage: { addListener, removeListener } } });

    const handler = vi.fn();
    const unsubscribe = subscribeToBroadcasts(handler);

    expect(addListener).toHaveBeenCalledTimes(1);
    const registered = addListener.mock.calls[0][0];

    registered({ type: "library.cleared" });
    expect(handler).toHaveBeenCalledWith({ type: "library.cleared" });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(registered);
  });
});
