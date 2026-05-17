import { SurfaceShell } from "../ui/components";

export function Options() {
  return (
    <SurfaceShell title="DevRecall Settings">
      <form className="mx-auto flex max-w-2xl flex-col gap-6">
        <label className="flex flex-col gap-2 text-sm font-medium text-slate-800">
          OpenAI API key
          <input
            type="password"
            autoComplete="off"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>

        <button
          type="button"
          disabled
          className="w-fit rounded-md bg-slate-200 px-3 py-2 text-sm font-medium text-slate-500"
        >
          Test connection
        </button>

        <label className="flex items-center gap-3 text-sm font-medium text-slate-800">
          <input type="checkbox" className="h-4 w-4 accent-accent" />
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
