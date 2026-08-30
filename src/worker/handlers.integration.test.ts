import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeUrl } from "../lib/urlNormalize";
import { ContentType, Platform } from "../shared/enums";
import type { DevRecallRequest, DevRecallResponse, WorkerBroadcast } from "../shared/messages";
import type { PageRecord, PageStatus } from "../shared/types";
import { handleMessage, type HandlerDeps } from "./handlers";
import { EMBEDDING_MODEL_ID, OpenAIProvider } from "./llm/OpenAIProvider";
import { ChunkRepo } from "./repository/ChunkRepo";
import { DevRecallDatabase } from "./repository/db";
import { PageRepo } from "./repository/PageRepo";
import { BulkTaskRunner, type BulkTaskProgress } from "./services/BulkTaskRunner";
import { CaptureService, SEMANTIC_INDEX_VERSION } from "./services/CaptureService";
import { RetrievalService } from "./services/RetrievalService";
import { computeEffectiveMode, type ModeStore, type StoredMode } from "./settings/ModeStore";

/**
 * Worker integration spec for issue #20's criterion: "Worker and UI tests use
 * observable OpenAI call counts to cover confirmation, sequential progress,
 * failure continuation, Cancel, Local-only precedence, and later
 * reconfirmation."
 *
 * Everything counts at the HTTP boundary, not at internal seams: a real
 * OpenAIProvider runs behind a stubbed global `fetch` (zero retry delays keep
 * counts deterministic), a real BulkTaskRunner drives a real CaptureService
 * over a real Dexie instance (fake-indexeddb). Each observed fetch call IS one
 * OpenAI request.
 *
 * Per-page accounting (see CaptureService.processPage): enrich = 1 x
 * chat/completions (tagging) + 1 x embeddings. Totals pinned below for a
 * confirmed 3-page batch: success -> 6; page-2 tagging fails with a
 * non-retryable 400 -> 5; Cancel while page 2 tags -> 3 (consent revocation
 * also blocks page 2's embeddings leg); Local-only between pages -> 2 with a
 * later confirmation adding 4 (total 6); key removal between pages -> 2.
 */

type FetchCall = { url: string; authorization: string | null };

type HarnessOptions = {
  apiKey?: string;
  storedMode?: StoredMode;
  /**
   * When the Nth OpenAI request (1-based; pages send chat/embed pairs) reaches
   * fetch, first run onHold against the live harness, then complete the held
   * request normally. Lands a Cancel while work is observably in flight.
   */
  holdNthRequest?: number;
  onHold?: (harness: Harness) => Promise<void>;
  /** Chat/completions calls whose body contains this text answer 400. */
  failChatForText?: string;
};

type Harness = {
  deps: HandlerDeps;
  database: DevRecallDatabase;
  pageRepo: PageRepo;
  chunkRepo: ChunkRepo;
  send(request: DevRecallRequest): Promise<DevRecallResponse>;
  seedKeywordReadyPage(slug: string): Promise<PageRecord>;
  armGate(atFetchCount: number, run: () => Promise<void>): void;
  armGate(atFetchCount: number, run: () => Promise<void>): void;
  fetchCalls(): FetchCall[];
  flush(times?: number): Promise<void>;
  eventually(assertion: () => void, tries?: number): Promise<void>;
  pageUpdatedStatuses(): PageStatus[];
  bulkProgress(): BulkTaskProgress[];
};

const openDatabases: DevRecallDatabase[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (openDatabases.length > 0) {
    const database = openDatabases.pop();
    try {
      await database?.delete();
    } catch {
      // best-effort cleanup
    }
  }
});

function tagPayload(): string {
  return JSON.stringify({
    summary: "Enriched summary.",
    contentType: "documentation",
    topics: ["integration"],
    technologies: ["test"],
    intent: "learning",
  });
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const calls: FetchCall[] = [];

  function makeHeld(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof URL ? input : input);
      const authorization = new Headers(init?.headers).get("Authorization");
      calls.push({ url, authorization });
      const isChat = url.includes("/chat/completions");

      if (isChat && options.failChatForText !== undefined) {
        const bodyText = String(init?.body);
        if (bodyText.includes(options.failChatForText)) {
          // A 400 is non-retryable by design, so the count stays exact.
          return { ok: false, status: 400, json: async () => ({}) };
        }
      }

      if (
        options.holdNthRequest !== undefined &&
        options.onHold &&
        calls.length === options.holdNthRequest
      ) {
        const held = makeHeld();
        void options.onHold(harness).then(() => held.release());
        await held.promise;
      }

      if (!isChat) {
        const requested = (JSON.parse(String(init?.body)) as { input: unknown[] }).input.length;
        return ok({
          data: Array.from({ length: requested }, (_, index) => ({ index, embedding: [3, 4] })),
        });
      }

      return ok({ choices: [{ message: { content: tagPayload() } }] });

      function ok(body: unknown) {
        return { ok: true, status: 200, json: async () => body };
      }
    }),
  );

  const database = new DevRecallDatabase(`devrecall-handlers-${crypto.randomUUID()}`);
  openDatabases.push(database);
  await database.delete();
  await database.open();

  const pageRepo = new PageRepo(database);
  const chunkRepo = new ChunkRepo(database);

  let currentApiKey = options.apiKey ?? "";

  let storedMode: StoredMode = options.storedMode ?? "hybrid";

  // Boundary gate: arm the API-key read so the first read that happens once
  // atFetchCount requests have been recorded parks until run resolves. The
  // parked read is the BulkTaskRunner's between-page consent check, giving the
  // test a deterministic window to change mode or remove the key.
  let gateAt = -1;
  let gateFired = false;
  let gateRun: (() => Promise<void>) | null = null;

  const apiKeyStore = {
    getApiKey: vi.fn(async (): Promise<string | null> => {
      if (gateAt >= 0 && !gateFired && calls.length >= gateAt) {
        gateFired = true;
        await gateRun?.();
      }
      return currentApiKey.trim().length > 0 ? currentApiKey : null;
    }),
    setApiKey: vi.fn(async (apiKey: string) => {
      currentApiKey = apiKey;
    }),
  };

  const modeStore: ModeStore = {
    getStoredMode: vi.fn(async () => storedMode),
    setStoredMode: vi.fn(async (mode: StoredMode) => {
      storedMode = mode;
    }),
    getEffectiveMode: vi.fn((hasApiKey: boolean) =>
      Promise.resolve(computeEffectiveMode(storedMode, hasApiKey)),
    ),
    getDefaultEffectiveMode: vi.fn((hasApiKey: boolean) =>
      computeEffectiveMode(storedMode, hasApiKey),
    ),
  };

  const openai = new OpenAIProvider([0, 0, 0]);
  const captureService = new CaptureService(
    pageRepo,
    // save() is out of scope here; seeds go straight into Dexie.
    { extract: () => Promise.reject(new Error("extraction unused in this spec")) },
    pageRepo,
    openai,
    chunkRepo,
    openai,
  );

  const broadcasts: WorkerBroadcast[] = [];

  const deps: HandlerDeps = {
    captureService,
    pageRepo,
    apiKeyStore,
    modeStore,
    testConnection: vi.fn(async () => ({ success: true, message: "spy connection" })),
    retrievalService: new RetrievalService(chunkRepo, pageRepo, openai, apiKeyStore),
    bulkRunner: new BulkTaskRunner(),
    semanticIndex: {
      embeddingModel: EMBEDDING_MODEL_ID,
      indexVersion: SEMANTIC_INDEX_VERSION,
    },
    broadcast: (message) => broadcasts.push(message),
    autoSaveSettings: {
      isEnabled: vi.fn(async () => false),
      setEnabled: vi.fn(async () => undefined),
    },
    persistentStorage: {
      request: vi.fn(async () => "unknown" as const),
      getState: vi.fn(async () => "unknown" as const),
    },
  };

  async function send(request: DevRecallRequest): Promise<DevRecallResponse> {
    let response: DevRecallResponse | undefined;
    await handleMessage(
      request,
      (reply) => {
        if (response !== undefined) {
          throw new Error("sendResponse called more than once");
        }
        response = reply;
      },
      deps,
    );
    if (response === undefined) {
      throw new Error("handler returned no response");
    }
    return response;
  }

  async function flush(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function eventually(assertion: () => void, tries = 60): Promise<void> {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        assertion();
        return;
      } catch {
        await flush();
      }
    }
    assertion();
  }

  async function seedKeywordReadyPage(slug: string): Promise<PageRecord> {
    const normalized = await normalizeUrl(`https://docs.example.com/${slug}`);
    const record: PageRecord = {
      id: crypto.randomUUID(),
      url: normalized.url,
      urlHash: normalized.urlHash,
      title: `Seeded ${slug}`,
      domain: normalized.domain,
      platform: Platform.Mdn,
      contentType: ContentType.Documentation,
      summary: "",
      topics: [],
      technologies: [],
      intent: "reference",
      fullText:
        `Seeded ${slug} body text about autoscaling pods, metrics pipelines, and dashboards. ` +
        "It carries enough prose that token chunking yields at least one chunk.",
      savedAt: 1_000,
      visitedAt: 1_000,
      readingTimeMs: 1_000,
      saveMode: "manual",
      status: "keyword_ready",
      schemaVersion: 1,
    };
    await database.pages.put(record);
    return record;
  }

  const harness: Harness = {
    deps,
    database,
    pageRepo,
    chunkRepo,
    send,
    seedKeywordReadyPage,
    armGate(atFetchCount, run) {
      gateAt = atFetchCount;
      gateRun = run;
    },
    fetchCalls: () => calls,
    flush,
    eventually,
    pageUpdatedStatuses: () =>
      broadcasts.flatMap((message) =>
        message.type === "page.updated" ? [message.payload.page.status] : [],
      ),
    bulkProgress: () =>
      broadcasts.flatMap((message) => (message.type === "bulk.progress" ? [message.payload] : [])),
  };
  return harness;
}

/**
 * Candidate order from pageIdsKeywordReady() is not seed order, so tests
 * identify pages positionally: the first two progress events with a
 * currentPageId name the pages that were actually processed (or attempted).
 */
function processedSequence(progress: BulkTaskProgress[]): string[] {
  const out: string[] = [];
  for (const event of progress) {
    if (event.currentPageId && !out.includes(event.currentPageId)) {
      out.push(event.currentPageId);
    }
  }
  return out;
}

describe("worker handlers integration — observable OpenAI call counts (#20)", () => {
  it("a confirmed 3-page batch sends exactly six requests, two per page, sequentially", async () => {
    const h = await makeHarness({ apiKey: "sk-test", storedMode: "hybrid" });
    await h.seedKeywordReadyPage("alpha");
    await h.seedKeywordReadyPage("beta");
    await h.seedKeywordReadyPage("gamma");

    const prepared = await h.send({ type: "library.prepareBulkEnrich", payload: {} });
    if (prepared.type !== "library.bulkEnrichPrepared") {
      throw new Error(`expected bulkEnrichPrepared, got ${prepared.type}`);
    }
    expect(prepared.payload.count).toBe(3);

    const started = await h.send({
      type: "library.bulkEnrich",
      payload: { batchId: prepared.payload.batchId },
    });
    expect(started.type).toBe("library.bulkEnrichStarted");

    await h.eventually(() => expect(h.fetchCalls()).toHaveLength(6));

    // Two requests per page, tagging before embeddings, strictly sequential.
    expect(h.fetchCalls().map((call) => (call.url.includes("/chat/") ? "chat" : "embed"))).toEqual([
      "chat",
      "embed",
      "chat",
      "embed",
      "chat",
      "embed",
    ]);
    for (const call of h.fetchCalls()) {
      expect(call.authorization).toBe("Bearer sk-test");
    }

    await h.eventually(() => {
      const last = h.bulkProgress().at(-1);
      expect(last).toMatchObject({ kind: "enrich", done: 3, total: 3, failed: 0 });
      expect(last?.canceled ?? false).toBe(false);
    });

    const pages = await h.database.pages.toArray();
    expect(pages.map((page) => page.status)).toEqual(["ready", "ready", "ready"]);
    for (const chunk of await h.chunkRepo.allChunks()) {
      expect(chunk.embedding?.constructor.name).toBe("Float32Array");
      expect(chunk.embeddingModel).toBe(EMBEDDING_MODEL_ID);
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  it("a failing tagging request spends the page but the batch continues to the next", async () => {
    const h = await makeHarness({
      apiKey: "sk-test",
      storedMode: "hybrid",
      failChatForText: "Seeded beta body text",
    });
    const alpha = await h.seedKeywordReadyPage("alpha");
    const beta = await h.seedKeywordReadyPage("beta");
    const gamma = await h.seedKeywordReadyPage("gamma");

    const prepared = await h.send({ type: "library.prepareBulkEnrich", payload: {} });
    if (prepared.type !== "library.bulkEnrichPrepared") {
      throw new Error(`expected bulkEnrichPrepared, got ${prepared.type}`);
    }
    await h.send({ type: "library.bulkEnrich", payload: { batchId: prepared.payload.batchId } });

    // Six minus one: beta's tagging call failed and its embeddings leg never ran.
    await h.eventually(() => expect(h.fetchCalls()).toHaveLength(5));
    await h.eventually(() => {
      const last = h.bulkProgress().at(-1);
      expect(last).toMatchObject({ done: 3, total: 3, failed: 1, remaining: 0 });
    });

    const chats = h.fetchCalls().filter((call) => call.url.includes("/chat/")).length;
    const embeds = h.fetchCalls().length - chats;
    expect(chats).toBe(3);
    expect(embeds).toBe(2);

    const betaStored = await h.pageRepo.getById(beta.id);
    expect(betaStored?.status).toBe("keyword_ready");
    expect(betaStored?.enrichmentError).toContain("400");

    // The unaffected pages still finished their enrichment.
    for (const page of [alpha, gamma]) {
      expect((await h.pageRepo.getById(page.id))?.status).toBe("ready");
    }
  });

  it("Cancel while a tagging request is in flight finishes it, then sends nothing further", async () => {
    const canceledReply = new Array<DevRecallResponse>();
    const h = await makeHarness({
      apiKey: "sk-test",
      storedMode: "hybrid",
      holdNthRequest: 3,
      onHold: async (live) => {
        const reply = await live.send({ type: "library.cancelBulk", payload: {} });
        canceledReply.push(reply);
      },
    });
    const seeded = [
      await h.seedKeywordReadyPage("alpha"),
      await h.seedKeywordReadyPage("beta"),
      await h.seedKeywordReadyPage("gamma"),
    ];

    const prepared = await h.send({ type: "library.prepareBulkEnrich", payload: {} });
    if (prepared.type !== "library.bulkEnrichPrepared") {
      throw new Error(`expected bulkEnrichPrepared, got ${prepared.type}`);
    }
    await h.send({ type: "library.bulkEnrich", payload: { batchId: prepared.payload.batchId } });

    // The first processed page spent both legs; the second page's in-flight
    // tagging call finished — and its embeddings leg was revoked together with
    // the consent. Nothing further was sent.
    await h.eventually(() => expect(h.fetchCalls()).toHaveLength(3));
    await h.flush(15);
    await h.eventually(() => {
      const last = h.bulkProgress().at(-1);
      expect(last?.canceled).toBe(true);
    });
    expect(canceledReply).toHaveLength(1);

    const [first] = processedSequence(h.bulkProgress());
    expect((await h.pageRepo.getById(first))?.status).toBe("ready");

    const embeddedChunks = (await h.chunkRepo.allChunks()).filter(
      (chunk) => chunk.embedding !== undefined,
    );
    expect(embeddedChunks.length).toBeGreaterThan(0);
    for (const chunk of embeddedChunks) {
      expect(chunk.pageId).toBe(first);
    }

    for (const page of seeded.filter((record) => record.id !== first)) {
      const stored = await h.pageRepo.getById(page.id);
      expect(stored?.status).toBe("keyword_ready");
      expect(stored?.enrichmentError).toBeUndefined();
    }
  });

  it("switching to Local-only between pages halts the queue, and a later confirmation resumes what remains", async () => {
    const h = await makeHarness({ apiKey: "sk-test", storedMode: "hybrid" });
    const seeded = [
      await h.seedKeywordReadyPage("alpha"),
      await h.seedKeywordReadyPage("beta"),
      await h.seedKeywordReadyPage("gamma"),
    ];

    // After the first processed page, park the runner's between-page key read
    // and flip to Local-only inside that window.
    h.armGate(2, async () => {
      const reply = await h.send({ type: "settings.setMode", payload: { mode: "local" } });
      expect(reply.type).toBe("settings.modeSet");
    });

    const firstBatch = await h.send({ type: "library.prepareBulkEnrich", payload: {} });
    if (firstBatch.type !== "library.bulkEnrichPrepared") {
      throw new Error(`expected bulkEnrichPrepared, got ${firstBatch.type}`);
    }
    await h.send({
      type: "library.bulkEnrich",
      payload: { batchId: firstBatch.payload.batchId },
    });

    await h.eventually(() => expect(h.fetchCalls()).toHaveLength(2));
    await h.flush(30);
    // Stable: nothing further gets sent after the mode flip.
    expect(h.fetchCalls()).toHaveLength(2);

    const haltedProgress = h.bulkProgress().at(-1);
    expect(haltedProgress).toMatchObject({ done: 1, total: 3, canceled: true });
    const [firstProcessed] = processedSequence(h.bulkProgress());
    expect((await h.pageRepo.getById(firstProcessed))?.status).toBe("ready");
    for (const page of seeded.filter((record) => record.id !== firstProcessed)) {
      const stored = await h.pageRepo.getById(page.id);
      expect(stored?.status).toBe("keyword_ready");
      expect(stored?.enrichmentError).toBeUndefined();
    }

    // A newer confirmation sees exactly the two still-eligible pages.
    const second = await h.send({ type: "library.prepareBulkEnrich", payload: {} });
    if (second.type !== "library.bulkEnrichPrepared") {
      throw new Error(`expected bulkEnrichPrepared, got ${second.type}`);
    }
    expect(second.payload.count).toBe(2);

    const restoredMode = await h.send({ type: "settings.setMode", payload: { mode: "hybrid" } });
    expect(restoredMode.type).toBe("settings.modeSet");

    const started = await h.send({
      type: "library.bulkEnrich",
      payload: { batchId: second.payload.batchId },
    });
    expect(started.type).toBe("library.bulkEnrichStarted");

    // Resumed run adds four requests; the grand total returns to a clean six.
    await h.eventually(() => expect(h.fetchCalls()).toHaveLength(6));
    await h.eventually(() => {
      const last = h.bulkProgress().at(-1);
      expect(last).toMatchObject({ done: 2, total: 2, failed: 0, remaining: 0 });
      expect(last?.canceled ?? false).toBe(false);
    });
    for (const page of seeded) {
      expect((await h.pageRepo.getById(page.id))?.status).toBe("ready");
    }
  });

  it("removing the key between pages stops paid work without rewriting the stored preference", async () => {
    const h = await makeHarness({ apiKey: "sk-test", storedMode: "hybrid" });
    const seeded = [await h.seedKeywordReadyPage("alpha"), await h.seedKeywordReadyPage("beta")];

    h.armGate(2, async () => {
      const reply = await h.send({ type: "settings.setApiKey", payload: { apiKey: "" } });
      expect(reply.type).toBe("settings.apiKeySet");
    });

    const prepared = await h.send({ type: "library.prepareBulkEnrich", payload: {} });
    if (prepared.type !== "library.bulkEnrichPrepared") {
      throw new Error(`expected bulkEnrichPrepared, got ${prepared.type}`);
    }
    await h.send({ type: "library.bulkEnrich", payload: { batchId: prepared.payload.batchId } });

    await h.eventually(() => expect(h.fetchCalls()).toHaveLength(2));
    await h.flush(30);
    expect(h.fetchCalls()).toHaveLength(2);
    expect(h.bulkProgress().at(-1)?.canceled).toBe(true);

    // The processed page kept its enrichment; everything else stayed locally
    // searchable with no errors attached.
    const [firstProcessed] = processedSequence(h.bulkProgress());
    expect((await h.pageRepo.getById(firstProcessed))?.status).toBe("ready");
    for (const page of seeded.filter((record) => record.id !== firstProcessed)) {
      const stored = await h.pageRepo.getById(page.id);
      expect(stored?.status).toBe("keyword_ready");
      expect(stored?.enrichmentError).toBeUndefined();
    }

    // Missing key forces effective Local without overwriting Hybrid storage.
    expect(vi.mocked(h.deps.modeStore.setStoredMode)).not.toHaveBeenCalled();
    const status = await h.send({ type: "settings.getStatus" });
    if (status.type !== "settings.status") {
      throw new Error(`expected settings.status, got ${status.type}`);
    }
    expect(status.payload).toMatchObject({
      hasApiKey: false,
      storedMode: "hybrid",
      effectiveMode: "local",
    });
  });
});
