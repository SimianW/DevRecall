import { useEffect, useState } from "react";
import { SurfaceShell } from "../ui/components";

type StatusResult = { hasApiKey: boolean };
type TestResult = { success: boolean; message: string };

type OptionsProps = {
  loadStatus?: () => Promise<StatusResult>;
  saveApiKey?: (apiKey: string) => Promise<void>;
  testConnection?: () => Promise<TestResult>;
};

const defaultLoadStatus = async (): Promise<StatusResult> => {
  const response = await chrome.runtime.sendMessage({ type: "settings.getStatus" });
  return response.payload;
};

const defaultSaveApiKey = async (apiKey: string): Promise<void> => {
  await chrome.runtime.sendMessage({
    type: "settings.setApiKey",
    payload: { apiKey },
  });
};

const defaultTestConnection = async (): Promise<TestResult> => {
  const response = await chrome.runtime.sendMessage({ type: "settings.testConnection" });
  return response.payload;
};

export function Options({
  loadStatus = defaultLoadStatus,
  saveApiKey = defaultSaveApiKey,
  testConnection = defaultTestConnection,
}: OptionsProps) {
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    loadStatus().then((status) => {
      if (status.hasApiKey) {
        setKeySaved(true);
      }
    });
  }, [loadStatus]);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    await saveApiKey(apiKey.trim());
    setKeySaved(true);
    setApiKey(""); // clear input for security/ux
    setTestResult(null); // clear previous test results
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection();
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  return (
    <SurfaceShell title="DevRecall Settings">
      <form 
        className="mx-auto flex max-w-2xl flex-col gap-6"
        onSubmit={(e) => { e.preventDefault(); handleSave(); }}
      >
        <label className="flex flex-col gap-2 text-sm font-medium text-slate-800">
          OpenAI API key
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keySaved ? "API key is set" : "sk-..."}
              className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={!apiKey.trim()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:bg-slate-300 disabled:text-slate-500"
            >
              Save
            </button>
          </div>
        </label>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!keySaved || testing}
            onClick={handleTestConnection}
            className="w-fit rounded-md bg-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {testing ? "Testing..." : "Test connection"}
          </button>
          {testResult && (
            <p className={`text-sm ${testResult.success ? "text-green-600" : "text-red-600"}`}>
              {testResult.message}
            </p>
          )}
        </div>

        <label className="flex items-center gap-3 text-sm font-medium text-slate-800">
          <input type="checkbox" disabled className="h-4 w-4 accent-accent" />
          Enable auto-save
        </label>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Storage</h2>
          <p className="mt-2 text-sm text-slate-500">0 pages, 0 chunks, 0 MB</p>
        </section>
      </form>
    </SurfaceShell>
  );
}
