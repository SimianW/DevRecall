import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeUrl } from "../../lib/urlNormalize";
import { ContentType, Platform } from "../../shared/enums";
import type { ExtractedPage, PageRecord, PageStatus } from "../../shared/types";
import type { DevRecallRequest, DevRecallResponse, WorkerBroadcast } from "../../shared/messages";
import { handleMessage, recoverStaleEnriching } from "../handlers";
import type { Embedder, PageTaggingResult } from "../llm/OpenAIProvider";
import { ChunkRepo } from "../repository/ChunkRepo";
import { DevRecallDatabase } from "../repository/db";
import { PageRepo } from "../repository/PageRepo";
import { BulkTaskRunner } from "./BulkTaskRunner";
import { computeEffectiveMode, type ModeStore, type StoredMode } from "../settings/ModeStore";
import {
  CaptureService,
  SEMANTIC_INDEX_VERSION,
  type ChunkWriter,
  type PageExtractor,
  type PageTagger,
} from "./CaptureService";
import { RetrievalService } from "./RetrievalService";

/**
 * Integration spec for the local-first (keyword-first) capture flow.
 *
 * Everything runs behind the typed worker request boundary (`handleMessage`),
 * the same entry `chrome.runtime.onMessage` uses in production: requests go in
 * as `DevRecallRequest`s, responses come out as `DevRecallResponse`s, and
 * broadcasts are captured from the injected `broadcast` port. The database is
 * a real Dexie instance over fake-indexeddb; the extractor is a fake content
 * script; every OpenAI touchpoint (tagger, embed, embedBatch) is a spy whose
 * call counts are asserted.
 *
 * Lifecycle under test (see `PageStatus` in shared/types.ts):
 *
 *   save ──► pending ──► keyword_ready ──► enriching ──► ready
 *                                    │         │
 *                                    │         └─ failure ─► keyword_ready (+ enrichmentError)
 *                                    └─ local failure ─► failed
 *
 * Besides the page lifecycle, this file pins two worker-contract additions:
 *
 * 1. `HandlerDeps` gains a `modeStore: ModeStore` — background enrichment
 *    after `page.save` must consult the resolved search mode, not just the
 *    API key, so "local" mode never calls OpenAI even with a key configured.
 * 2. `handlers.ts` exports `recoverStaleEnriching(deps)` — called at worker
 *    startup (top level in worker/index.ts) to reset pages the MV3 lifecycle
 *    killed mid-enrichment back to "keyword_ready".
 */

const FIXTURE_TAB_ID = 7;

const fixturePage: ExtractedPage = {
  url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
  title: "Fetch API",
  fullText:
    "The fetch API retrieves resources across the network. A fetch call takes a Request and " +
    "returns a Promise that resolves to a Response. The response body is exposed as a readable " +
    "stream, so a large payload can be consumed chunk by chunk without buffering the whole body " +
    "in memory. Streams can be cancelled through AbortController, tee'd into two branches, and " +
    "piped through transform streams. Because fetch returns a promise, it composes naturally " +
    "with async and await, and the readable stream reader gives fine-grained control over " +
    "backpressure when downloading large files or streaming server-sent events to the page.",
  readingTimeMs: 42_000,
};

const taggingResult: PageTaggingResult = {
  summary: "Enriched summary of the page.",
  contentType: ContentType.Documentation,
  topics: ["web-apis", "streams"],
  technologies: ["Fetch API"],
  intent: "learning",
};

type Harness = {
  deps: Parameters<typeof handleMessage>[2];
  database: DevRecallDatabase;
  pageRepo: PageRepo;
  chunkRepo: ChunkRepo;
  tagger: PageTagger;
  embedder: Embedder;
  setTab(tabId: number, page: ExtractedPage): void;
  send(request: DevRecallRequest): Promise<DevRecallResponse>;
  flush(times?: number): Promise<void>;
  eventually(assertion: () => void, tries?: number): Promise<void>;
  pageUpdated(): Array<Extract<WorkerBroadcast, { type: "page.updated" }>>;
  pageUpdatedStatuses(): PageStatus[];
};

const openDatabases: DevRecallDatabase[] = [];

async function makeHarness(
  options: {
    apiKey?: string | null;
    storedMode?: StoredMode;
    failChunkWrite?: Error;
  } = {},
): Promise<Harness> {
  const database = new DevRecallDatabase(`devrecall-integration-${crypto.randomUUID()}`);
  openDatabases.push(database);
  // Open fresh (fake-indexeddb may retain state from an identically named db).
  await database.delete();
  await database.open();

  const pageRepo = new PageRepo(database);
  const chunkRepo = new ChunkRepo(database);
  if (options.failChunkWrite) {
    database.chunks.hook("creating", () => {
      throw options.failChunkWrite;
    });
  }

  // LLM spies — every OpenAI touchpoint is counted and controllable per test.
  const tagger: PageTagger = {
    summarizeAndTag: vi.fn(async () => taggingResult),
  };
  const embedder: Embedder = {
    embeddingModel: "spy:embedding",
    embed: vi.fn(async () => Float32Array.from([1, 0])),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0]))),
  };

  // Extractor fake: the content script side of the boundary. Tests register a
  // fixture per tab id before sending `page.save`.
  const tabs = new Map<number, ExtractedPage>();
  const extractor: PageExtractor = {
    extract: vi.fn(async (tabId: number) => {
      const page = tabs.get(tabId);
      if (!page) {
        throw new Error(`no fixture registered for tab ${tabId}`);
      }
      return page;
    }),
  };

  const chunkWriter: ChunkWriter = {
    replaceChunksForPage: (pageId, texts) => chunkRepo.replaceChunksForPage(pageId, texts),
    commitProcessedPage: (pageId, chunks, embeddingModel, pageUpdate, indexVersion) =>
      chunkRepo.commitProcessedPage(pageId, chunks, embeddingModel, pageUpdate, indexVersion),
  };

  const apiKeyStore = {
    getApiKey: vi.fn(async (): Promise<string | null> => options.apiKey ?? null),
    setApiKey: vi.fn(async () => undefined),
  };

  let storedMode: StoredMode = options.storedMode ?? "hybrid";
  const modeStore: ModeStore = {
    getStoredMode: vi.fn(async () => storedMode),
    setStoredMode: vi.fn(async (mode: StoredMode) => {
      storedMode = mode;
    }),
    getEffectiveMode: vi.fn(async (hasApiKey: boolean) =>
      computeEffectiveMode(storedMode, hasApiKey),
    ),
    getDefaultEffectiveMode: vi.fn((hasApiKey: boolean) => (hasApiKey ? "hybrid" : "local")),
  };

  const broadcasts: WorkerBroadcast[] = [];

  const deps = {
    captureService: new CaptureService(
      pageRepo,
      extractor,
      pageRepo,
      tagger,
      chunkWriter,
      embedder,
    ),
    pageRepo,
    apiKeyStore,
    testConnection: vi.fn(async () => ({ success: true, message: "spy connection" })),
    retrievalService: new RetrievalService(chunkRepo, pageRepo, embedder, apiKeyStore),
    bulkRunner: new BulkTaskRunner(),
    semanticIndex: {
      embeddingModel: embedder.embeddingModel,
      indexVersion: SEMANTIC_INDEX_VERSION,
    },
    broadcast: (message: WorkerBroadcast) => {
      broadcasts.push(message);
    },
    autoSaveSettings: {
      isEnabled: vi.fn(async () => false),
      setEnabled: vi.fn(async () => undefined),
    },
    persistentStorage: {
      request: vi.fn(async () => "unknown" as const),
      getState: vi.fn(async () => "unknown" as const),
    },
    modeStore,
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

  /** Polls `assertion` across macrotask boundaries until it passes. */
  async function eventually(assertion: () => void, tries = 40): Promise<void> {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        assertion();
        return;
      } catch {
        await flush();
      }
    }
    assertion(); // surface the failing expectation
  }

  function pageUpdated(): Array<Extract<WorkerBroadcast, { type: "page.updated" }>> {
    return broadcasts.filter(
      (message): message is Extract<WorkerBroadcast, { type: "page.updated" }> =>
        message.type === "page.updated",
    );
  }

  return {
    deps,
    database,
    pageRepo,
    chunkRepo,
    tagger,
    embedder,
    setTab: (tabId, page) => {
      tabs.set(tabId, page);
    },
    send,
    flush,
    eventually,
    pageUpdated,
    pageUpdatedStatuses: () => pageUpdated().map((message) => message.payload.page.status),
  };
}

/** Writes a fully-formed record straight into Dexie (bypasses capture). */
async function seedPage(
  h: Harness,
  status: PageStatus,
  url: string,
  overrides: Partial<PageRecord> = {},
): Promise<PageRecord> {
  const normalized = await normalizeUrl(url);
  const record: PageRecord = {
    id: ulid(),
    url: normalized.url,
    urlHash: normalized.urlHash,
    title: `Seeded ${status} page`,
    domain: normalized.domain,
    platform: Platform.Web,
    contentType: ContentType.Page,
    summary: "",
    topics: [],
    technologies: [],
    intent: "reference",
    fullText: `Seeded ${status} page body text about autoscaling pods and metrics.`,
    savedAt: 1_000,
    visitedAt: 1_000,
    readingTimeMs: 1_000,
    saveMode: "manual",
    status,
    schemaVersion: 1,
    ...overrides,
  };
  await h.database.pages.put(record);
  return record;
}

afterEach(async () => {
  while (openDatabases.length > 0) {
    const database = openDatabases.pop();
    try {
      await database?.delete();
    } catch {
      // best-effort cleanup
    }
  }
});

describe("CaptureService integration — local-first capture flow", () => {
  it("no API key: save goes pending → keyword_ready with zero OpenAI calls and is immediately keyword-searchable", async () => {
    const h = await makeHarness({ apiKey: null });
    h.setTab(FIXTURE_TAB_ID, fixturePage);

    const response = await h.send({ type: "page.save", payload: { tabId: FIXTURE_TAB_ID } });
    if (response.type !== "page.saved") {
      throw new Error(`expected page.saved, got ${response.type}`);
    }
    const pageId = response.payload.page.id;

    // The RPC response already reports the locally-indexed state.
    expect(response.payload.page.status).toBe("keyword_ready");

    // Zero OpenAI calls: no tagging, no embeddings, not even single embed.
    expect(h.tagger.summarizeAndTag).not.toHaveBeenCalled();
    expect(h.embedder.embed).not.toHaveBeenCalled();
    expect(h.embedder.embedBatch).not.toHaveBeenCalled();

    // Stored state: keyword_ready, with platform/contentType classified
    // locally (no network needed for filter values).
    const stored = await h.pageRepo.getById(pageId);
    expect(stored).toMatchObject({
      status: "keyword_ready",
      platform: Platform.Mdn,
      contentType: ContentType.Documentation,
    });

    // Keyword chunks exist and carry no embeddings.
    const chunks = await h.chunkRepo.allChunks();
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.embedding).toBeUndefined();
    }

    // Exactly one broadcast — the keyword_ready page. No key means no
    // background work, so nothing else follows.
    await h.flush(3);
    expect(h.pageUpdatedStatuses()).toEqual(["keyword_ready"]);

    // Local-first payoff: the page is searchable with no API key at all.
    const search = await h.send({
      type: "search.run",
      payload: { query: "fetch readable stream" },
    });
    if (search.type !== "search.results") {
      throw new Error(`expected search.results, got ${search.type}`);
    }
    expect(search.payload.searchMode).toBe("local");
    expect(search.payload.results.some((hit) => hit.page.id === pageId)).toBe(true);
  });

  it("local mode with a key configured: still pending → keyword_ready, zero OpenAI calls", async () => {
    const h = await makeHarness({ apiKey: "sk-test", storedMode: "local" });
    h.setTab(FIXTURE_TAB_ID, fixturePage);

    const response = await h.send({ type: "page.save", payload: { tabId: FIXTURE_TAB_ID } });
    if (response.type !== "page.saved") {
      throw new Error(`expected page.saved, got ${response.type}`);
    }

    expect(response.payload.page.status).toBe("keyword_ready");

    // A configured key must not trigger enrichment when the stored mode is
    // "local" — background enrichment is gated on the effective mode.
    await h.flush(5);
    expect(h.tagger.summarizeAndTag).not.toHaveBeenCalled();
    expect(h.embedder.embed).not.toHaveBeenCalled();
    expect(h.embedder.embedBatch).not.toHaveBeenCalled();

    const stored = await h.pageRepo.getById(response.payload.page.id);
    expect(stored?.status).toBe("keyword_ready");
    expect(stored?.summary).toBe("");

    // Only the save broadcast — no enrichment transition ever follows.
    expect(h.pageUpdatedStatuses()).toEqual(["keyword_ready"]);
  });

  it("hybrid mode with a key: pending → keyword_ready → enriching → ready", async () => {
    const h = await makeHarness({ apiKey: "sk-test", storedMode: "hybrid" });
    h.setTab(FIXTURE_TAB_ID, fixturePage);

    // Gate the tagger so the enriching phase can be observed mid-flight.
    let resolveTagging!: (value: PageTaggingResult) => void;
    const taggingGate = new Promise<PageTaggingResult>((resolve) => {
      resolveTagging = resolve;
    });
    vi.mocked(h.tagger.summarizeAndTag).mockImplementationOnce(() => taggingGate);

    const response = await h.send({ type: "page.save", payload: { tabId: FIXTURE_TAB_ID } });
    if (response.type !== "page.saved") {
      throw new Error(`expected page.saved, got ${response.type}`);
    }
    const pageId = response.payload.page.id;

    // Phase 1 — save resolves as keyword_ready and broadcasts it first.
    expect(response.payload.page.status).toBe("keyword_ready");
    expect(h.pageUpdatedStatuses()[0]).toBe("keyword_ready");

    // Phase 2 — background enrichment starts: one tagging call, stored state
    // flips to "enriching" while OpenAI work is in flight.
    await h.eventually(() => expect(h.tagger.summarizeAndTag).toHaveBeenCalledTimes(1));
    expect((await h.pageRepo.getById(pageId))?.status).toBe("enriching");

    // Phase 3 — enrichment completes: ready.
    resolveTagging(taggingResult);
    await h.eventually(() => {
      expect(h.pageUpdatedStatuses().at(-1)).toBe("ready");
    });

    const stored = await h.pageRepo.getById(pageId);
    expect(stored?.status).toBe("ready");
    expect(stored?.summary).toBe(taggingResult.summary);
    expect(stored?.topics).toEqual(taggingResult.topics);
    expect(stored?.technologies).toEqual(taggingResult.technologies);

    // Exactly one enrichment round trip: one tagging call, one embed batch
    // (and no single-query embed) — no duplicate or retried enrichment.
    expect(h.tagger.summarizeAndTag).toHaveBeenCalledTimes(1);
    expect(h.embedder.embedBatch).toHaveBeenCalledTimes(1);
    expect(h.embedder.embed).not.toHaveBeenCalled();

    // Chunks were replaced by the embedded token chunks.
    const chunks = await h.chunkRepo.allChunks();
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(ArrayBuffer.isView(chunk.embedding)).toBe(true);
      expect(chunk.embedding?.constructor.name).toBe("Float32Array");
      expect(chunk.embeddingModel).toBe("spy:embedding");
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }

    // Broadcast order: keyword_ready precedes ready.
    const statuses = h.pageUpdatedStatuses();
    expect(statuses.indexOf("keyword_ready")).toBeLessThan(statuses.lastIndexOf("ready"));
  });

  it("enrichment failure: the page returns to keyword_ready with enrichmentError and stays searchable", async () => {
    const h = await makeHarness({ apiKey: "sk-test", storedMode: "hybrid" });
    h.setTab(FIXTURE_TAB_ID, fixturePage);
    vi.mocked(h.tagger.summarizeAndTag).mockRejectedValueOnce(new Error("rate_limited"));

    const response = await h.send({ type: "page.save", payload: { tabId: FIXTURE_TAB_ID } });
    if (response.type !== "page.saved") {
      throw new Error(`expected page.saved, got ${response.type}`);
    }
    const pageId = response.payload.page.id;
    expect(response.payload.page.status).toBe("keyword_ready");

    // The failure path must not use "failed" — the local copy keeps working.
    await h.eventually(() => {
      const last = h.pageUpdated().at(-1);
      expect(last?.payload.page.status).toBe("keyword_ready");
      expect(last?.payload.page.enrichmentError).toBe("rate_limited");
    });

    const stored = await h.pageRepo.getById(pageId);
    expect(stored?.status).toBe("keyword_ready");
    expect(stored?.enrichmentError).toBe("rate_limited");

    // Tagging failed before embedding — no embed call, chunks untouched.
    expect(h.embedder.embedBatch).not.toHaveBeenCalled();
    const chunks = await h.chunkRepo.allChunks();
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.embedding).toBeUndefined();
    }

    // Local-first resilience: the keyword index still serves this page.
    const search = await h.send({
      type: "search.run",
      payload: { query: "fetch readable stream" },
    });
    if (search.type !== "search.results") {
      throw new Error(`expected search.results, got ${search.type}`);
    }
    expect(search.payload.results.some((hit) => hit.page.id === pageId)).toBe(true);
  });

  it("local save failure: the stored record is marked failed and the RPC reports an error", async () => {
    const h = await makeHarness({
      apiKey: "sk-test",
      failChunkWrite: new Error("IndexedDB quota exceeded"),
    });
    h.setTab(FIXTURE_TAB_ID, fixturePage);

    const response = await h.send({ type: "page.save", payload: { tabId: FIXTURE_TAB_ID } });
    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.payload.message).toMatch(/quota/i);
    }

    // The captured record survives with status "failed" (not left "pending").
    const all = await h.database.pages.toArray();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      status: "failed",
      localSaveError: expect.stringContaining("quota"),
    });
    expect(all[0]?.enrichmentError).toBeUndefined();

    // No keyword index was written, no enrichment attempted.
    expect(await h.chunkRepo.allChunks()).toHaveLength(0);
    expect(h.tagger.summarizeAndTag).not.toHaveBeenCalled();

    // The UI was never told a page was saved.
    expect(h.pageUpdatedStatuses()).toEqual([]);
  });

  it("deduplication treats every non-failed status as saved; a failed page is saved again", async () => {
    const h = await makeHarness({ apiKey: "sk-test" });
    const seeded = {
      pending: await seedPage(h, "pending", "https://docs.example.com/pending"),
      keyword_ready: await seedPage(h, "keyword_ready", "https://docs.example.com/keyword-ready"),
      enriching: await seedPage(h, "enriching", "https://docs.example.com/enriching"),
      ready: await seedPage(h, "ready", "https://docs.example.com/ready"),
    };
    const failedSeed = await seedPage(h, "failed", fixturePage.url, {
      localSaveError: "previous local failure",
    });

    // All four live statuses read as "saved" with their status echoed.
    for (const [expectedStatus, page] of Object.entries(seeded)) {
      const response = await h.send({ type: "page.statusForUrl", payload: { url: page.url } });
      expect(response).toMatchObject({
        type: "page.urlStatus",
        payload: { saved: true, status: expectedStatus },
      });
    }

    // "failed" is the one status that does NOT count as saved — the UI should
    // offer saving again.
    const failedStatus = await h.send({
      type: "page.statusForUrl",
      payload: { url: failedSeed.url },
    });
    expect(failedStatus).toMatchObject({
      type: "page.urlStatus",
      payload: {
        saved: true,
        status: "failed",
        localSaveError: "previous local failure",
      },
    });

    // Saving the failed URL re-runs the full local pipeline on the same
    // record (urlHash dedup) instead of skipping it as "already saved".
    h.setTab(FIXTURE_TAB_ID, fixturePage);
    const resave = await h.send({ type: "page.save", payload: { tabId: FIXTURE_TAB_ID } });
    if (resave.type !== "page.saved") {
      throw new Error(`expected page.saved, got ${resave.type}`);
    }
    expect(resave.payload.page.id).toBe(failedSeed.id);
    expect(resave.payload.page.status).toBe("keyword_ready");

    const stored = await h.pageRepo.getById(failedSeed.id);
    expect(stored?.status).toBe("keyword_ready");
    expect(stored?.enrichmentError).toBeUndefined();

    // One record per URL — no duplicate row was created.
    expect(await h.database.pages.count()).toBe(5);

    // Let the fire-and-forget enrichment of the resave settle before teardown.
    await h.flush(3);
  });

  it("worker startup recovers a stale enriching page back to keyword_ready", async () => {
    const h = await makeHarness({ apiKey: "sk-test" });
    const stale = await seedPage(h, "enriching", "https://docs.example.com/stale");
    const ready = await seedPage(h, "ready", "https://docs.example.com/ready");
    const keywordReady = await seedPage(
      h,
      "keyword_ready",
      "https://docs.example.com/keyword-ready",
    );
    const pending = await seedPage(h, "pending", "https://docs.example.com/pending");

    // The stale page keeps its keyword index from capture time.
    await h.chunkRepo.replaceChunksForPage(stale.id, ["stale page keyword chunk body"]);
    const chunksBefore = await h.chunkRepo.allChunks();

    // The MV3 worker was killed mid-enrichment; startup runs the recovery.
    await recoverStaleEnriching(h.deps);

    // Only "enriching" is reset — every other status is left untouched.
    expect((await h.pageRepo.getById(stale.id))?.status).toBe("keyword_ready");
    expect((await h.pageRepo.getById(ready.id))?.status).toBe("ready");
    expect((await h.pageRepo.getById(keywordReady.id))?.status).toBe("keyword_ready");
    expect((await h.pageRepo.getById(pending.id))?.status).toBe("pending");

    // The keyword index survives recovery untouched.
    expect(await h.chunkRepo.allChunks()).toHaveLength(chunksBefore.length);
  });
});
