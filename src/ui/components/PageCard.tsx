import type { PageListItem } from "../../shared/types";

type PageCardProps = {
  page: PageListItem;
};

export function PageCard({ page }: PageCardProps) {
  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-3">
      <h2 className="text-sm font-semibold text-slate-900">{page.title}</h2>
      <p className="mt-1 text-xs text-slate-500">{page.domain}</p>
      <p className="mt-2 line-clamp-2 text-sm text-slate-600">
        {page.summary || page.url}
      </p>
    </article>
  );
}
