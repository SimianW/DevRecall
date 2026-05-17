export const APP_NAME = "DevRecall";
export const APP_VERSION = "0.1.0";

export type PersistentStorageState = "unknown" | "granted" | "denied";

export type DevRecallRequest =
  | { type: "devrecall.ping" }
  | { type: "settings.getStatus" };

export type DevRecallResponse =
  | {
      type: "devrecall.pong";
      payload: {
        appName: typeof APP_NAME;
        version: typeof APP_VERSION;
      };
    }
  | {
      type: "settings.status";
      payload: {
        hasApiKey: boolean;
        persistentStorage: PersistentStorageState;
      };
    };
