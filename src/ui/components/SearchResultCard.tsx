import { useState } from "react";

import type { PageHit, SearchMatchReason } from "../../shared/types";

type SearchResultCardProps = {
  hit: PageHit;
  onDelete?: (id: string) => void;
  pendingAction?: "delete";
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

const HIGHLIGHT_STYLES =
  "[&_mark]:rounded [&_mark]:bg-amber-400/40 [&_mark]:px-0.5 [&_mark]:text-foreground";

function formatLabel(value: string) {
  return value
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function SearchResultCard({ hit, onDelete, pendingAction }: SearchResultCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { page, bestChunk, matchReason, metadataMatches } = hit;
  const badge = BADGE[matchReason];
  const resultHtml = metadataMatches.summaryHighlightedHtml ?? bestChunk.highlightedHtml;

  return (
    <article
      aria-busy={Boolean(pendingAction)}
      className="rounded-lg border border-default bg-surface-raised px-4 py-3 text-foreground shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          className={`min-w-0 break-words font-serif text-sm font-semibold text-foreground ${HIGHLIGHT_STYLES}`}
        >
          <a href={page.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {metadataMatches.titleHighlightedHtml === null ? (
              page.title
            ) : (
              <span dangerouslySetInnerHTML={{ __html: metadataMatches.titleHighlightedHtml }} />
            )}
          </a>
        </h2>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>

      <p className="mt-1 break-all text-xs text-foreground/60">{page.domain}</p>

      {metadataMatches.fields && metadataMatches.fields.length > 0 && (
        <dl
          className="mt-2 grid gap-1 text-xs text-foreground/70"
          aria-label="Matched page details"
        >
          {metadataMatches.fields.map(({ field, highlightedHtml }) => (
            <div key={field} className="min-w-0 break-all">
              <dt className="inline font-medium">
                {field === "url" ? "URL" : formatLabel(field)}:{" "}
              </dt>
              <dd
                className={`inline ${HIGHLIGHT_STYLES}`}
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            </div>
          ))}
        </dl>
      )}

      <p
        className={`mt-2 line-clamp-4 break-words text-sm leading-6 text-foreground/75 ${HIGHLIGHT_STYLES}`}
        dangerouslySetInnerHTML={{ __html: resultHtml }}
      />

      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="mt-2 text-xs font-medium text-accent hover:underline"
      >
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded && (
        <div className="mt-3 grid gap-3 border-t border-default/80 pt-3">
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/55">
              Content evidence
            </h3>
            <p className="mt-1 text-sm leading-6 text-foreground/75">{bestChunk.text}</p>
          </section>
          <div className="grid gap-3 sm:grid-cols-3">
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/55">
                Platform
              </h3>
              <p className="mt-1 text-sm text-foreground/75">{formatLabel(page.platform)}</p>
            </section>
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/55">
                Type
              </h3>
              <p className="mt-1 text-sm text-foreground/75">{formatLabel(page.contentType)}</p>
            </section>
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/55">
                Saved
              </h3>
              <p className="mt-1 text-sm text-foreground/75">
                {new Date(page.savedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </section>
          </div>
          {page.technologies.length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/55">
                Technologies
              </h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {page.technologies.map((technology) => (
                  <span
                    key={technology}
                    className="inline-flex max-w-full break-words items-center rounded-full border border-default/80 bg-foreground/5 px-2 py-1 text-xs text-foreground/75"
                  >
                    {technology}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

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
            disabled={pendingAction === "delete"}
            onClick={() => onDelete(page.id)}
            className="text-xs font-medium text-red-700 hover:underline dark:text-red-300"
          >
            {pendingAction === "delete" ? "Deleting…" : "Delete"}
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
