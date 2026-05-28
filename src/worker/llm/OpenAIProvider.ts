import type { Intent, SourceType, TaggingResult } from "../../shared/types";

export type PageTagger = {
  summarizeAndTag(
    fullText: string,
    title: string,
    url: string,
    apiKey: string,
  ): Promise<TaggingResult>;
};

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];

const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set<SourceType>([
  "official_docs",
  "github_issue",
  "stackoverflow",
  "blog",
  "paper",
  "course_material",
  "unknown",
]);

const VALID_INTENTS: ReadonlySet<string> = new Set<Intent>([
  "learning",
  "debugging",
  "reference",
  "implementation",
  "comparison",
]);

const SYSTEM_PROMPT = `You are a technical document classifier for a developer's browsing history. Analyze the web page and return a JSON object with these exact fields:

- "summary" (string): 1-3 concise sentences summarizing the page content for a developer.
- "sourceType" (string): One of "official_docs", "github_issue", "stackoverflow", "blog", "paper", "course_material", "unknown".
- "topics" (string[]): 2-5 lowercase topic tags.
- "technologies" (string[]): Specific technologies or libraries mentioned.
- "intent" (string): One of "learning", "debugging", "reference", "implementation", "comparison".

Return ONLY the JSON object.`;

export class OpenAIProvider implements PageTagger {
  constructor(private readonly retryDelays: number[] = DEFAULT_RETRY_DELAYS) {}

  async summarizeAndTag(
    fullText: string,
    title: string,
    url: string,
    apiKey: string,
  ): Promise<TaggingResult> {
    const truncatedText = fullText.slice(0, MAX_TEXT_LENGTH);
    const userPrompt = `Page title: ${title}\nPage URL: ${url}\n\nPage content:\n${truncatedText}`;

    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const responseBody = await this.fetchWithRetry(apiKey, body);

    return parseTaggingResponse(responseBody);
  }

  private async fetchWithRetry(
    apiKey: string,
    body: string,
  ): Promise<unknown> {
    const maxAttempts = this.retryDelays.length + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(OPENAI_CHAT_URL, {
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

      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < maxAttempts - 1
      ) {
        await sleep(this.retryDelays[attempt]);
        continue;
      }

      throw new Error(`OpenAI API error: ${response.status}`);
    }

    throw new Error("OpenAI API request failed after retries");
  }
}

function parseTaggingResponse(body: unknown): TaggingResult {
  const data = body as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("No content in OpenAI response");
  }

  const parsed = JSON.parse(content) as Record<string, unknown>;

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    sourceType: VALID_SOURCE_TYPES.has(parsed.sourceType as string)
      ? (parsed.sourceType as SourceType)
      : "unknown",
    topics: Array.isArray(parsed.topics)
      ? parsed.topics.filter((t): t is string => typeof t === "string")
      : [],
    technologies: Array.isArray(parsed.technologies)
      ? parsed.technologies.filter((t): t is string => typeof t === "string")
      : [],
    intent: VALID_INTENTS.has(parsed.intent as string)
      ? (parsed.intent as Intent)
      : "reference",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        max_tokens: 1,
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
