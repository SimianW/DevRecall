import { describe, expect, it } from "vitest";

import { APP_NAME, APP_VERSION } from "../shared/messages";
import { handleRequest } from "./index";

describe("worker request handler", () => {
  it("responds to a ping request", async () => {
    await expect(handleRequest({ type: "devrecall.ping" })).resolves.toEqual({
      type: "devrecall.pong",
      payload: {
        appName: APP_NAME,
        version: APP_VERSION,
      },
    });
  });

  it("returns the initial settings status", async () => {
    await expect(
      handleRequest({ type: "settings.getStatus" }),
    ).resolves.toEqual({
      type: "settings.status",
      payload: {
        hasApiKey: false,
        persistentStorage: "unknown",
      },
    });
  });
});
