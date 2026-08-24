export type BulkTaskKind = "enrich" | "semantic";

export type BulkTaskProgress = {
  kind: BulkTaskKind;
  done: number;
  total: number;
  failed: number;
  remaining: number;
  currentPageId?: string;
  canceled?: boolean;
};

export type BulkTaskInput = {
  kind: BulkTaskKind;
  pageIds: string[];
  runPage(pageId: string): Promise<void>;
  shouldContinue(): Promise<boolean>;
  onProgress(progress: BulkTaskProgress): void;
};

export type BulkTaskRunnerPort = {
  begin(input: BulkTaskInput): void;
  cancel(): boolean;
  isRunning(): boolean;
};

/**
 * Runs paid page operations one at a time. State is intentionally in memory:
 * if MV3 kills the worker, the queue disappears and paid work is never replayed.
 */
export class BulkTaskRunner implements BulkTaskRunnerPort {
  private activeToken: symbol | null = null;
  private cancelRequested = false;

  begin(input: BulkTaskInput): void {
    if (this.activeToken !== null) {
      throw new Error("A bulk operation is already running");
    }

    const token = Symbol(input.kind);
    this.activeToken = token;
    this.cancelRequested = false;
    input.onProgress(this.progress(input, 0, 0, input.pageIds[0]));

    void this.run(input, token).catch((error) => {
      console.error("[DevRecall] bulk operation error:", error);
    });
  }

  cancel(): boolean {
    if (this.activeToken === null) {
      return false;
    }
    this.cancelRequested = true;
    return true;
  }

  isRunning(): boolean {
    return this.activeToken !== null;
  }

  private async run(input: BulkTaskInput, token: symbol): Promise<void> {
    let done = 0;
    let failed = 0;

    try {
      for (const pageId of input.pageIds) {
        const allowed =
          this.activeToken === token && !this.cancelRequested && (await input.shouldContinue());
        // Cancellation may arrive while shouldContinue() is reading the latest
        // mode or key. Check the token again before starting the next page.
        if (!allowed || this.activeToken !== token || this.cancelRequested) {
          input.onProgress({ ...this.progress(input, done, failed), canceled: true });
          return;
        }

        input.onProgress(this.progress(input, done, failed, pageId));
        try {
          await input.runPage(pageId);
        } catch {
          failed += 1;
        }
        done += 1;
        if (this.activeToken !== token || this.cancelRequested) {
          input.onProgress({ ...this.progress(input, done, failed), canceled: true });
          return;
        }
        input.onProgress(this.progress(input, done, failed));
      }
    } finally {
      if (this.activeToken === token) {
        this.activeToken = null;
        this.cancelRequested = false;
      }
    }
  }

  private progress(
    input: BulkTaskInput,
    done: number,
    failed: number,
    currentPageId?: string,
  ): BulkTaskProgress {
    return {
      kind: input.kind,
      done,
      total: input.pageIds.length,
      failed,
      remaining: input.pageIds.length - done,
      ...(currentPageId ? { currentPageId } : {}),
    };
  }
}
