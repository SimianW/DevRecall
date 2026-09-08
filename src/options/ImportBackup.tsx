import { useRef, useState } from "react";

import { MAX_BACKUP_BYTES, parseBackup } from "../shared/backup";
import { requireResponse } from "../ui/rpc";

type ImportResult = { imported: number; skipped: number };

async function restoreBackup(json: string): Promise<ImportResult> {
  const response = await requireResponse(
    { type: "data.import", payload: { json } },
    "data.imported",
  );
  return response.payload;
}

export function ImportBackup({
  importData = restoreBackup,
  onImported,
}: {
  importData?: (json: string) => Promise<ImportResult>;
  onImported: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const [preview, setPreview] = useState<{ json: string; count: number; name: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function chooseFile(file: File | undefined) {
    const revision = ++selection.current;
    setPreview(null);
    setResult(null);
    setError(null);
    if (!file) return;
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error("Choose a backup smaller than 25 MB.");
      const json = await file.text();
      const pages = parseBackup(json);
      if (revision === selection.current)
        setPreview({ json, count: pages.length, name: file.name });
    } catch (cause) {
      if (revision === selection.current)
        setError(cause instanceof Error ? cause.message : "Could not read this backup.");
    }
  }

  async function confirmImport() {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await importData(preview.json);
      setResult(imported);
      setPreview(null);
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-default pt-4">
      <h3 className="text-sm font-medium text-foreground">Restore a backup</h3>
      <p className="mt-1 text-sm text-foreground/65">
        Import a DevRecall JSON export, up to 25 MB and 5,000 pages. Existing pages are kept and
        duplicate URLs are skipped. Saved summaries and tags are restored. Keyword search is rebuilt
        locally; semantic search can be added later.
      </p>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        aria-label="Choose DevRecall backup"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          void chooseFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="mt-3 rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium text-foreground/80 hover:bg-foreground/10 disabled:opacity-50"
      >
        Import backup
      </button>
      {preview && (
        <div className="mt-3 rounded-md border border-accent/25 bg-accent/5 p-3">
          <p className="break-words text-sm text-foreground">
            {preview.name}: {preview.count} {preview.count === 1 ? "page" : "pages"} ready to
            import.
          </p>
          <p className="mt-1 text-xs text-foreground/65">
            This stays on your device and does not send data to OpenAI.
          </p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={() => void confirmImport()}
              disabled={busy || preview.count === 0}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Importing..." : "Confirm import"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPreview(null)}
              className="px-2 py-1 text-sm text-foreground/70"
            >
              Cancel import
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">
          Imported {result.imported} {result.imported === 1 ? "page" : "pages"}. Skipped{" "}
          {result.skipped} {result.skipped === 1 ? "duplicate" : "duplicates"}.
        </p>
      )}
    </div>
  );
}
