import { normalize } from "../../lib/vector";
import { CONTENT_TYPE_VALUES, ContentType, isContentType } from "../../shared/enums";
import type { Intent } from "../../shared/types";

export type PageTaggingResult = {
  summary: string;
  contentType: ContentType;
  topics: string[];
  technologies: string[];
  intent: Intent;
};

export type MaySendOpenAIRequest = () => Promise<boolean> | boolean;

export class OpenAIRequestAuthorizationError extends Error {
  constructor() {
    super("OpenAI request authorization was revoked");
    this.name = "OpenAIRequestAuthorizationError";
  }
}

export type PageTagger = {
  summarizeAndTag(
    fullText: string,
    title: string,
    url: string,
    apiKey: string,
    localContentType: ContentType,
    maySend?: MaySendOpenAIRequest,
  ): Promise<PageTaggingResult>;
};

export type Embedder = {
  readonly embeddingModel: string;
  embed(text: string, apiKey: string, maySend?: MaySendOpenAIRequest): Promise<Float32Array>;
  embedBatch(
    texts: string[],
    apiKey: string,
    maySend?: MaySendOpenAIRequest,
  ): Promise<Float32Array[]>;
};

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_MODEL_ID = "openai:text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
const MODEL = "gpt-5.6-luna";
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const VALID_INTENTS: ReadonlySet<string> = new Set<Intent>([
  "learning",
  "debugging",
  "reference",
  "implementation",
  "comparison",
]);

const SYSTEM_PROMPT = `You are a technical document classifier for a developer's browsing history. Analyze the web page and return a JSON object with these exact fields:

- "summary" (string): 1-3 concise sentences summarizing the page content for a developer.
- "contentType" (string): The kind of content on the page.
- "topics" (string[]): 2-5 lowercase topic tags.
- "technologies" (string[]): Specific technologies or libraries mentioned.
- "intent" (string): One of "learning", "debugging", "reference", "implementation", "comparison".

Return only the fields defined by the response schema.`;

const TAGGING_RESPONSE_SCHEMA = {
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
} as const;

export class OpenAIProvider implements PageTagger, Embedder {
  readonly embeddingModel = EMBEDDING_MODEL_ID;

  constructor(
    private readonly retryDelays: number[] = DEFAULT_RETRY_DELAYS,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async summarizeAndTag(
    fullText: string,
    title: string,
    url: string,
    apiKey: string,
    _localContentType: ContentType,
    maySend?: MaySendOpenAIRequest,
  ): Promise<PageTaggingResult> {
    const truncatedText = fullText.slice(0, MAX_TEXT_LENGTH);
    const userPrompt = `Page title: ${title}\nPage URL: ${url}\n\nPage content:\n${truncatedText}`;

    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: "developer", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      reasoning_effort: "none",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "devrecall_page_enrichment",
          strict: true,
          schema: TAGGING_RESPONSE_SCHEMA,
        },
      },
      temperature: 0.2,
    });

    const responseBody = await this.fetchWithRetry(OPENAI_CHAT_URL, apiKey, body, maySend);

    return parseTaggingResponse(responseBody);
  }

  async embedBatch(
    texts: string[],
    apiKey: string,
    maySend?: MaySendOpenAIRequest,
  ): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const body = JSON.stringify({ model: EMBEDDING_MODEL, input: texts });
    const responseBody = await this.fetchWithRetry(OPENAI_EMBEDDINGS_URL, apiKey, body, maySend);

    return parseEmbeddingResponse(responseBody, texts.length);
  }

  async embed(text: string, apiKey: string, maySend?: MaySendOpenAIRequest): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text], apiKey, maySend);
    return vector;
  }

  private async fetchWithRetry(
    url: string,
    apiKey: string,
    body: string,
    maySend?: MaySendOpenAIRequest,
  ): Promise<unknown> {
    const maxAttempts = this.retryDelays.length + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (maySend && !(await maySend())) {
        throw new OpenAIRequestAuthorizationError();
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
          throw new Error("OpenAI API request timed out", { cause: error });
        }
        throw error;
      }

      if (response.ok) {
        try {
          // Keep the timeout active while consuming the body as well as while
          // waiting for response headers.
          return await response.json();
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error("OpenAI API request timed out", { cause: error });
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      }

      clearTimeout(timeout);

      if (response.status === 401) {
        throw new Error("Invalid API key");
      }

      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts - 1) {
        await sleep(this.retryDelays[attempt]);
        continue;
      }

      throw new Error(`OpenAI API error: ${response.status}`);
    }

    throw new Error("OpenAI API request failed after retries");
  }
}

function parseTaggingResponse(body: unknown): PageTaggingResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Invalid tagging response shape");
  }
  const data = body as {
    choices?: Array<{ message?: { content?: string; refusal?: string | null } }>;
  };

  const message = data.choices?.[0]?.message;
  const content = message?.content;

  if (message?.refusal || typeof content !== "string" || content.length === 0) {
    throw new Error("Invalid tagging response content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Invalid tagging response JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid tagging response fields");
  }

  const fields = parsed as Record<string, unknown>;
  const requiredFields = ["summary", "contentType", "topics", "technologies", "intent"];
  if (requiredFields.some((field) => !Object.hasOwn(fields, field))) {
    throw new Error("Missing required tagging response field");
  }

  if (typeof fields.summary !== "string" || fields.summary.trim().length === 0) {
    throw new Error("Invalid tagging response summary");
  }
  if (!Array.isArray(fields.topics) || fields.topics.some((topic) => typeof topic !== "string")) {
    throw new Error("Invalid tagging response topics");
  }
  if (
    !Array.isArray(fields.technologies) ||
    fields.technologies.some((technology) => typeof technology !== "string")
  ) {
    throw new Error("Invalid tagging response technologies");
  }
  if (!VALID_INTENTS.has(fields.intent as string)) {
    throw new Error("Invalid tagging response intent");
  }
  if (!isContentType(fields.contentType)) {
    throw new Error("Invalid tagging response content type");
  }

  return {
    summary: fields.summary,
    contentType: fields.contentType,
    topics: fields.topics,
    technologies: fields.technologies,
    intent: fields.intent as Intent,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEmbeddingResponse(body: unknown, expectedCount: number): Float32Array[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Unexpected embedding response shape");
  }
  const data = body as { data?: unknown[] };

  if (!Array.isArray(data.data) || data.data.length !== expectedCount) {
    throw new Error("Unexpected embedding response shape");
  }

  const rows = [...data.data];
  if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new Error("Unexpected embedding response rows");
  }
  const typedRows = rows as Array<{ embedding?: unknown; index?: unknown }>;
  if (typedRows.some((row) => typeof row.index !== "number" || !Number.isInteger(row.index))) {
    throw new Error("Unexpected embedding response indexes");
  }
  typedRows.sort((a, b) => (a.index as number) - (b.index as number));
  if (typedRows.some((row, index) => row.index !== index)) {
    throw new Error("Unexpected embedding response indexes");
  }

  let dimension: number | undefined;
  return typedRows.map((row) => {
    if (
      !Array.isArray(row.embedding) ||
      row.embedding.length === 0 ||
      row.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error("Missing or invalid embedding in OpenAI response");
    }

    if (row.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error("Unexpected embedding dimensions in OpenAI response");
    }

    if (dimension === undefined) {
      dimension = row.embedding.length;
    } else if (row.embedding.length !== dimension) {
      throw new Error("Inconsistent embedding dimensions in OpenAI response");
    }

    const vector = Float32Array.from(row.embedding);
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error("Embedding value overflows Float32");
    }
    const normalized = normalize(vector);
    if (normalized.every((value) => value === 0)) {
      throw new Error("Zero-length embedding in OpenAI response");
    }
    return normalized;
  });
}

export async function testOpenAIConnection(
  apiKey: string,
): Promise<{ success: boolean; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "none",
      }),
    });

    if (response.ok) {
      return { success: true, message: "Connection successful" };
    }

    if (response.status === 401) {
      return { success: false, message: "Invalid API key" };
    }

    return { success: false, message: `API error: ${response.status}` };
  } catch {
    return { success: false, message: "Network error" };
  } finally {
    clearTimeout(timeout);
  }
}
