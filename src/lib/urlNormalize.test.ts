import { describe, expect, it } from "vitest";

import { normalizeUrl } from "./urlNormalize";

describe("normalizeUrl", () => {
  it("removes fragments and tracking query params before hashing", async () => {
    const result = await normalizeUrl(
      "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API?utm_source=demo&foo=bar#greeting",
    );

    expect(result.url).toBe(
      "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API?foo=bar",
    );
    expect(result.domain).toBe("developer.mozilla.org");
    expect(result.urlHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sorts remaining query params so equivalent URLs dedupe", async () => {
    const first = await normalizeUrl("https://react.dev/reference?a=1&b=2");
    const second = await normalizeUrl("https://react.dev/reference?b=2&a=1");

    expect(first.url).toBe("https://react.dev/reference?a=1&b=2");
    expect(second.url).toBe(first.url);
    expect(second.urlHash).toBe(first.urlHash);
  });
});
