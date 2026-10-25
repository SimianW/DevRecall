import type { DevRecallRequest, DevRecallResponse, WorkerBroadcast } from "../shared/messages";

/**
 * Send a typed request to the worker. Returns the full typed response when the
 * worker answers with `expectedType`, otherwise null (chrome unavailable,
 * worker returned an error/mismatched type, or the channel rejected).
 * Fail-soft on purpose: UI callers decide their own fallbacks.
 */
export async function sendRequest<T extends DevRecallResponse["type"]>(
  request: DevRecallRequest,
  expectedType: T,
): Promise<Extract<DevRecallResponse, { type: T }> | null> {
  try {
    return await sendRequestOrThrow(request, expectedType);
  } catch {
    return null;
  }
}

/**
 * Like `sendRequest`, but rejects instead of returning null. A worker `error`
 * response rejects with the worker's message. Use it where a silent fallback
 * would look like success, such as exporting or deleting the library.
 */
export async function sendRequestOrThrow<T extends DevRecallResponse["type"]>(
  request: DevRecallRequest,
  expectedType: T,
): Promise<Extract<DevRecallResponse, { type: T }>> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("DevRecall is unavailable");
  }

  const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse | undefined;

  if (response?.type === expectedType) {
    return response as Extract<DevRecallResponse, { type: T }>;
  }
  if (response?.type === "error") {
    throw new Error(response.payload.message);
  }
  throw new Error("DevRecall did not respond");
}

/** Subscribe to worker broadcasts. Returns an unsubscribe function. */
export function subscribeToBroadcasts(handler: (message: WorkerBroadcast) => void): () => void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
    return () => {};
  }

  const listener = (message: unknown) => {
    handler(message as WorkerBroadcast);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
