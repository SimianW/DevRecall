import type { PageHit, SearchMatchReason } from "../../shared/types";

type SearchResultCardProps = {
  hit: PageHit;
  onDelete?: (id: string) => void;
};

const BADGE: Record<SearchMatchReason, { label: string; className: string }> = {
  keyword: {
    label: "keyword",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  vector: {
    label: "matched by meaning",
    className: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  both: {
    label: "keyword + meaning",
    className: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
};

export function SearchResultCard({ hit, onDelete }: SearchResultCardProps) {
  const { page, bestChunk, matchReason } = hit;
  const badge = BADGE[matchReason];

  return (
    <article className="rounded-lg border border-default bg-surface-raised px-4 py-3 text-foreground shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-serif text-sm font-semibold text-foreground">
          <a
            href={page.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {page.title}
          </a>
        </h2>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>

      <p className="mt-1 text-xs text-foreground/60">{page.domain}</p>

      <p
        className="mt-2 text-sm leading-6 text-foreground/75 [&_mark]:rounded [&_mark]:bg-amber-400/40 [&_mark]:px-0.5 [&_mark]:text-foreground"
        dangerouslySetInnerHTML={{ __html: bestChunk.highlightedHtml }}
      />

      {page.topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {page.topics.map((topic) => (
            <span
              key={topic}
              className="inline-flex items-center rounded-full border border-default/80 bg-foreground/5 px-2 py-1 text-xs text-foreground/75"
            >
              {topic}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-3 border-t border-default/80 pt-3">
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(page.id)}
            className="text-xs font-medium text-red-700 hover:underline dark:text-red-300"
          >
            Delete
          </button>
        )}
        <a
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-accent hover:underline"
        >
          Open →
        </a>
      </div>
    </article>
  );
}
