import { afterEach, describe, expect, it, vi } from "vitest";

import { dot } from "../../lib/vector";
import { CONTENT_TYPE_VALUES, ContentType } from "../../shared/enums";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  OpenAIProvider,
  type PageTaggingResult,
  testOpenAIConnection,
} from "./OpenAIProvider";

function embedding(...values: number[]): number[] {
  return [...values, ...Array(EMBEDDING_DIMENSIONS - values.length).fill(0)];
}

function embeddingWithDimension(dimension: number, ...values: number[]): number[] {
  return [...values, ...Array(dimension - values.length).fill(0)];
}

const taggingResult: PageTaggingResult = {
  summary: "HPA autoscales pods based on CPU and memory metrics.",
  contentType: ContentType.Documentation,
  topics: ["kubernetes", "autoscaling"],
  technologies: ["Kubernetes"],
  intent: "reference",
};

function mockFetchOk(result: PageTaggingResult) {
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
      ContentType.Page,
    );

    expect(result).toEqual(taggingResult);
    expect(fetch).toHaveBeenCalledOnce();

    const [url, options] = vi.mocked(fetch).mock.calls[0];

    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((options?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test123");

    const requestBody = JSON.parse(options?.body as string);
    expect(requestBody.model).toBe("gpt-5.6-luna");
    expect(requestBody.messages[0].role).toBe("developer");
    expect(requestBody.reasoning_effort).toBe("none");
    expect(requestBody.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "devrecall_page_enrichment",
        strict: true,
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            contentType: { type: "string", enum: CONTENT_TYPE_VALUES },
            topics: { type: "array", items: { type: "string" } },
            technologies: { type: "array", items: { type: "string" } },
            intent: {
              type: "string",
              enum: ["learning", "debugging", "reference", "implementation", "comparison"],
            },
          },
          required: ["summary", "contentType", "topics", "technologies", "intent"],
          additionalProperties: false,
        },
      },
    });
    expect(requestBody.response_format.json_schema.schema.properties).not.toHaveProperty(
      "platform",
    );
    expect(requestBody.response_format.json_schema.schema.properties).not.toHaveProperty(
      "sourceType",
    );
  });

  it.each(CONTENT_TYPE_VALUES)("accepts the approved content type %s", async (contentType) => {
    globalThis.fetch = mockFetchOk({ ...taggingResult, contentType });
    const provider = new OpenAIProvider([]);

    const result = await provider.summarizeAndTag(
      "text",
      "title",
      "https://example.com",
      "sk-test",
      ContentType.Page,
    );

    expect(result.contentType).toBe(contentType);
  });

  it("throws on 401 without retrying", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-bad", ContentType.Page),
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
      ContentType.Page,
    );

    expect(result).toEqual(taggingResult);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry after request authorization is revoked", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const maySend = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const provider = new OpenAIProvider([0]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Page, maySend),
    ).rejects.toThrow("OpenAI request authorization was revoked");

    expect(fetch).toHaveBeenCalledOnce();
    expect(maySend).toHaveBeenCalledTimes(2);
  });

  it("aborts a request that exceeds the configured timeout", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    );
    globalThis.fetch = fetchMock;
    const provider = new OpenAIProvider([], 1);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Page),
    ).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the timeout active while reading a response body", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
        return Promise.resolve({
          ok: true,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        } as Response);
      },
    );
    globalThis.fetch = fetchMock;
    const provider = new OpenAIProvider([], 1);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Page),
    ).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry a network failure because the request outcome is ambiguous", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network failure"));
    globalThis.fetch = fetchMock;
    const provider = new OpenAIProvider([0]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Page),
    ).rejects.toThrow("network failure");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an invalid content type even when the HTTP response is successful", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "A summary",
                  contentType: "INVALID",
                  topics: [],
                  technologies: ["React"],
                  intent: "reference",
                }),
              },
            },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Article),
    ).rejects.toThrow("Invalid tagging response content type");
  });

  it("rejects a tagging response when a required field is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "A summary",
                  topics: ["typescript"],
                  technologies: ["TypeScript"],
                  intent: "learning",
                }),
              },
            },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Course),
    ).rejects.toThrow("Missing required");
  });

  it.each([
    ["summary", { summary: 42 }],
    ["topics", { topics: {} }],
    ["technologies", { technologies: [null] }],
    ["intent", { intent: "unknown" }],
  ])("rejects malformed %s even when the HTTP response is successful", async (_field, override) => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({ ...taggingResult, ...override }),
              },
            },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Course),
    ).rejects.toThrow("Invalid tagging response");
  });

  it("ignores a platform field in an untrusted response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...taggingResult,
                  platform: "github",
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
      ContentType.Page,
    );

    expect(result).toEqual(taggingResult);
    expect(result).not.toHaveProperty("platform");
  });

  it("rejects when the model refuses tagging", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { refusal: "I cannot classify this page.", content: null } }],
        }),
    });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Question),
    ).rejects.toThrow("Invalid tagging response");
  });

  it("rejects malformed tagging JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "{not valid JSON" } }] }),
    });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Repository),
    ).rejects.toThrow("Invalid tagging response JSON");
  });

  it("rejects when the tagging response body is not an object", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    });
    const provider = new OpenAIProvider([]);

    await expect(
      provider.summarizeAndTag("text", "title", "url", "sk-test", ContentType.Article),
    ).rejects.toThrow("Invalid tagging response shape");
  });
});

describe("testOpenAIConnection", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns success for a valid key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    const result = await testOpenAIConnection("sk-valid");

    expect(result).toEqual({
      success: true,
      message: "Connection successful",
    });

    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(options?.body as string)).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning_effort: "none",
    });
  });

  it("returns failure for an invalid key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const result = await testOpenAIConnection("sk-invalid");

    expect(result).toEqual({
      success: false,
      message: "Invalid API key",
    });
  });

  it("returns failure on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await testOpenAIConnection("sk-test");

    expect(result).toEqual({ success: false, message: "Network error" });
  });
});

describe("OpenAIProvider embeddings", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to the embeddings endpoint and returns normalized vectors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { index: 0, embedding: embedding(3, 4) },
            { index: 1, embedding: embedding(0, 5) },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    const vectors = await provider.embedBatch(["alpha", "beta"], "sk-test");

    expect(vectors).toHaveLength(2);
    expect(vectors[0][0]).toBeCloseTo(0.6, 6); // 3-4-5 triangle, normalized
    expect(vectors[0][1]).toBeCloseTo(0.8, 6);
    expect(dot(vectors[1], vectors[1])).toBeCloseTo(1, 6); // unit length

    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(options?.body as string)).toEqual({
      model: "text-embedding-3-small",
      input: ["alpha", "beta"],
    });
  });

  it("reorders rows by their response index", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { index: 1, embedding: embedding(0, 1) },
            { index: 0, embedding: embedding(1, 0) },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    const vectors = await provider.embedBatch(["first", "second"], "sk-test");

    expect(Array.from(vectors[0]).slice(0, 2)).toEqual([1, 0]); // index 0 first
    expect(Array.from(vectors[1]).slice(0, 2)).toEqual([0, 1]);
  });

  it("embeds a single text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ index: 0, embedding: embedding(0, 3) }] }),
    });
    const provider = new OpenAIProvider([]);

    const vector = await provider.embed("solo", "sk-test");

    expect(Array.from(vector).slice(0, 2)).toEqual([0, 1]);
  });

  it("returns an empty array without calling fetch for empty input", async () => {
    globalThis.fetch = vi.fn();
    const provider = new OpenAIProvider([]);

    const vectors = await provider.embedBatch([], "sk-test");

    expect(vectors).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on a 401 from the embeddings endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const provider = new OpenAIProvider([]);

    await expect(provider.embedBatch(["x"], "sk-bad")).rejects.toThrow("Invalid API key");
  });

  it("throws when the response shape is wrong", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }), // count mismatch
    });
    const provider = new OpenAIProvider([]);

    await expect(provider.embedBatch(["x"], "sk-test")).rejects.toThrow();
  });

  it("rejects duplicate or out-of-range response indexes", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { index: 0, embedding: embedding(1, 0) },
            { index: 0, embedding: embedding(0, 1) },
          ],
        }),
    });
    const provider = new OpenAIProvider([]);

    await expect(provider.embedBatch(["first", "second"], "sk-test")).rejects.toThrow("indexes");
  });

  it("requires every embedding row to carry a contiguous index", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: embedding(1, 0) }] }),
    });
    const provider = new OpenAIProvider([]);

    await expect(provider.embedBatch(["missing index"], "sk-test")).rejects.toThrow("indexes");
  });

  it("rejects non-finite and zero-length vectors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ index: 0, embedding: embedding(Number.NaN, 0) }] }),
    });
    const provider = new OpenAIProvider([]);

    await expect(provider.embedBatch(["x"], "sk-test")).rejects.toThrow("invalid embedding");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ index: 0, embedding: embedding(0, 0) }] }),
    });
    await expect(provider.embedBatch(["x"], "sk-test")).rejects.toThrow("Zero-length");
  });

  it("rejects malformed rows, float32 overflow, and inconsistent dimensions", async () => {
    const provider = new OpenAIProvider([]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [null] }),
    });
    await expect(provider.embedBatch(["x"], "sk-test")).rejects.toThrow("rows");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ index: 0, embedding: embedding(1e100) }] }),
    });
    await expect(provider.embedBatch(["x"], "sk-test")).rejects.toThrow("overflows");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { index: 0, embedding: embedding(1, 0) },
            { index: 1, embedding: embeddingWithDimension(1537, 1, 0, 0) },
          ],
        }),
    });
    await expect(provider.embedBatch(["first", "second"], "sk-test")).rejects.toThrow("dimensions");
  });

  it("exposes a stable embedding model id", () => {
    expect(new OpenAIProvider([]).embeddingModel).toBe(EMBEDDING_MODEL_ID);
    expect(EMBEDDING_MODEL_ID).toBe("openai:text-embedding-3-small");
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });
});
