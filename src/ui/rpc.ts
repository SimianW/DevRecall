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
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }

  try {
    const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse | undefined;

    if (!response || response.type !== expectedType) {
      return null;
    }

    return response as Extract<DevRecallResponse, { type: T }>;
  } catch {
    return null;
  }
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
