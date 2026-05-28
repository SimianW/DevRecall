import type { PageListItem } from "../../shared/types";

type PageCardProps = {
  page: PageListItem;
};

function StatusBadge({ status }: { status: PageListItem["status"] }) {
  if (status === "ready") return null;

  if (status === "failed") {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
        Failed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
      Processing...
    </span>
  );
}

export function PageCard({ page }: PageCardProps) {
  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{page.title}</h2>
        <StatusBadge status={page.status} />
      </div>
      <p className="mt-1 text-xs text-slate-500">{page.domain}</p>
      <p className="mt-2 line-clamp-2 text-sm text-slate-600">
        {page.summary || page.url}
      </p>
    </article>
  );
}
