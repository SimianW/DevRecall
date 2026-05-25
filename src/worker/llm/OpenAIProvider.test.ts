import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaggingResult } from "../../shared/types";
import { OpenAIProvider, testOpenAIConnection } from "./OpenAIProvider";

const taggingResult: TaggingResult = {
  summary: "HPA autoscales pods based on CPU and memory metrics.",
  sourceType: "official_docs",
  topics: ["kubernetes", "autoscaling"],
  technologies: ["Kubernetes"],
  intent: "reference",
};

function mockFetchOk(result: TaggingResult) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: JSON.stringify(result) } }],
      }),
  });
}

describe("OpenAIProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a tagging request and parses the response", async () => {
    globalThis.fetch = mockFetchOk(taggingResult);
    const provider = new OpenAIProvider([]);

    const result = await provider.summarizeAndTag(
      "The HorizontalPodAutoscaler automatically updates workload resources.",
      "Horizontal Pod Autoscaling",
      "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      "sk-test123",
    );

    expect(result).toEqual(taggingResult);
    expect(fetch).toHaveBeenCalledOnce();

    const [url, options] = vi.mocked(fetch).mock.calls[0];

    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((options?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test123",
    );
  });

  it("throws on 401 without retrying", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401 });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-bad"),
    ).rejects.toThrow("Invalid API key");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify(taggingResult) } }],
          }),
      });
    const provider = new OpenAIProvider([0]);

    const result = await provider.summarizeAndTag(
      "text",
      "title",
      "url",
      "sk-test",
    );

    expect(result).toEqual(taggingResult);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to defaults for malformed LLM output", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "A summary",
                  sourceType: "INVALID",
                  topics: "not-an-array",
                  technologies: ["React"],
                }),
              },
            },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    const result = await provider.summarizeAndTag(
      "text",
      "title",
      "url",
      "sk-test",
    );

    expect(result).toEqual({
      summary: "A summary",
      sourceType: "unknown",
      topics: [],
      technologies: ["React"],
      intent: "reference",
    });
  });
});

describe("testOpenAIConnection", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns success for a valid key", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    const result = await testOpenAIConnection("sk-valid");

    expect(result).toEqual({
      success: true,
      message: "Connection successful",
    });
  });

  it("returns failure for an invalid key", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401 });

    const result = await testOpenAIConnection("sk-invalid");

    expect(result).toEqual({
      success: false,
      message: "Invalid API key",
    });
  });

  it("returns failure on network error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("Network error"));

    const result = await testOpenAIConnection("sk-test");

    expect(result).toEqual({ success: false, message: "Network error" });
  });
});
