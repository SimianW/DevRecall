import { SurfaceShell } from "../ui/components";

const filters = ["All", "Docs", "SO", "GH"] as const;

export function App() {
  return (
    <SurfaceShell
      title="DevRecall"
      actions={
        <button
          type="button"
          aria-label="Settings"
          className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-600"
        >
          Settings
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <input
          type="search"
          aria-label="Search saved pages"
          placeholder="Search saved pages"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <div className="flex gap-2">
          {filters.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filter === "All"}
              className="rounded-md border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 aria-pressed:border-accent aria-pressed:text-accent"
            >
              {filter}
            </button>
          ))}
        </div>

        <section className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
          <h2 className="text-sm font-semibold text-slate-900">
            No saved pages yet
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            Saved pages will appear here.
          </p>
        </section>
      </div>
    </SurfaceShell>
  );
}
