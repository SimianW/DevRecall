import type { PageHit } from "../../shared/types";

type SearchResultCardProps = {
  hit: PageHit;
};

export function SearchResultCard({ hit }: SearchResultCardProps) {
  const { page, bestChunk, matchReason } = hit;

  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          <a href={page.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {page.title}
          </a>
        </h2>
        <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
          {matchReason}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-500">{page.domain}</p>

      <p
        className="mt-2 text-sm text-slate-600 [&_mark]:rounded [&_mark]:bg-amber-200 [&_mark]:px-0.5 [&_mark]:text-slate-900"
        dangerouslySetInnerHTML={{ __html: bestChunk.highlightedHtml }}
      />

      {page.topics.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {page.topics.map((topic) => (
            <span
              key={topic}
              className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
            >
              {topic}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
