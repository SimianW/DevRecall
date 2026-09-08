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
    return await requireResponse(request, expectedType);
  } catch {
    return null;
  }
}

/** Operations must receive an acknowledgement before the UI reports success. */
export async function requireResponse<T extends DevRecallResponse["type"]>(
  request: DevRecallRequest,
  expectedType: T,
): Promise<Extract<DevRecallResponse, { type: T }>> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("DevRecall is unavailable. Reload the extension and try again.");
  }

  const response = (await chrome.runtime.sendMessage(request)) as DevRecallResponse | undefined;

  if (response?.type === "error") {
    throw new Error(response.payload.message);
  }
  if (!response || response.type !== expectedType) {
    throw new Error("DevRecall did not confirm the operation. Please try again.");
  }
  return response as Extract<DevRecallResponse, { type: T }>;
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
