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
const MODEL = "gpt-5.6-luna";
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];

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

  constructor(private readonly retryDelays: number[] = DEFAULT_RETRY_DELAYS) {}

  async summarizeAndTag(
    fullText: string,
    title: string,
    url: string,
    apiKey: string,
    localContentType: ContentType,
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

    return parseTaggingResponse(responseBody, localContentType);
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
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });

      if (response.ok) {
        return response.json();
      }

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

function fallbackTaggingResult(localContentType: ContentType): PageTaggingResult {
  return {
    summary: "",
    contentType: localContentType,
    topics: [],
    technologies: [],
    intent: "reference",
  };
}

function parseTaggingResponse(body: unknown, localContentType: ContentType): PageTaggingResult {
  const data = body as {
    choices?: Array<{ message?: { content?: string; refusal?: string | null } }>;
  };

  const message = data.choices?.[0]?.message;
  const content = message?.content;

  if (message?.refusal || typeof content !== "string" || content.length === 0) {
    return fallbackTaggingResult(localContentType);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return fallbackTaggingResult(localContentType);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fallbackTaggingResult(localContentType);
  }

  const fields = parsed as Record<string, unknown>;

  return {
    summary: typeof fields.summary === "string" ? fields.summary : "",
    contentType: isContentType(fields.contentType) ? fields.contentType : localContentType,
    topics: Array.isArray(fields.topics)
      ? fields.topics.filter((topic): topic is string => typeof topic === "string")
      : [],
    technologies: Array.isArray(fields.technologies)
      ? fields.technologies.filter(
          (technology): technology is string => typeof technology === "string",
        )
      : [],
    intent: VALID_INTENTS.has(fields.intent as string) ? (fields.intent as Intent) : "reference",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEmbeddingResponse(body: unknown, expectedCount: number): Float32Array[] {
  const data = body as { data?: Array<{ embedding?: number[]; index?: number }> };

  if (!Array.isArray(data.data) || data.data.length !== expectedCount) {
    throw new Error("Unexpected embedding response shape");
  }

  return [...data.data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row) => {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new Error("Missing embedding in OpenAI response");
      }

      return normalize(Float32Array.from(row.embedding));
    });
}

export async function testOpenAIConnection(
  apiKey: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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
  }
}
