import { useState, type ReactNode } from "react";

import type { PageListItem } from "../../shared/types";

type PageCardProps = {
  page: PageListItem;
  onDelete?: (id: string) => void;
  onRetry?: (id: string) => void;
};

function StatusBadge({ status }: { status: PageListItem["status"] }) {
  if (status === "ready") return null;

  if (status === "failed") {
    return (
      <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
        Failed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
      Processing...
    </span>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-default/80 bg-foreground/5 px-2 py-1 text-xs text-foreground/75">
      {label}
    </span>
  );
}

function DetailGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/55">
        {label}
      </h3>
      {children}
    </section>
  );
}

function formatSourceLabel(sourceType: PageListItem["sourceType"]) {
  return sourceType
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function PageCard({ page, onDelete, onRetry }: PageCardProps) {
  const [expanded, setExpanded] = useState(false);

  const savedDate = new Date(page.savedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const summary = page.summary.trim() || page.url;

  return (
    <article className="rounded-lg border border-default bg-surface-raised px-4 py-3 text-foreground shadow-sm">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <h2 className="font-serif text-sm font-semibold text-foreground">{page.title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <StatusBadge status={page.status} />
          <span className="text-xs text-foreground/40">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      <p className="mt-1 text-xs text-foreground/60">{page.domain}</p>

      <p className={`mt-2 text-sm leading-6 text-foreground/75 ${expanded ? "" : "line-clamp-2"}`}>
        {summary}
      </p>

      {expanded && (
        <div className="mt-4 flex flex-col gap-4 border-t border-default/80 pt-4">
          <DetailGroup label="Summary">
            <p className="text-sm leading-6 text-foreground/75">{summary}</p>
            {page.status === "failed" && page.errorReason && (
              <p className="text-xs text-red-700 dark:text-red-300">{page.errorReason}</p>
            )}
          </DetailGroup>

          {page.topics.length > 0 && (
            <DetailGroup label="Topics">
              <div className="flex flex-wrap gap-2">
                {page.topics.map((t) => (
                  <Chip key={t} label={t} />
                ))}
              </div>
            </DetailGroup>
          )}

          {page.technologies.length > 0 && (
            <DetailGroup label="Technologies">
              <div className="flex flex-wrap gap-2">
                {page.technologies.map((t) => (
                  <Chip key={t} label={t} />
                ))}
              </div>
            </DetailGroup>
          )}

          <div className="grid gap-3 border-t border-default/70 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailGroup label="Source">
                <p className="text-sm text-foreground/75">{formatSourceLabel(page.sourceType)}</p>
              </DetailGroup>
              <DetailGroup label="Saved">
                <p className="text-sm text-foreground/75">{savedDate}</p>
              </DetailGroup>
            </div>

            <div className="flex flex-wrap items-center gap-3 sm:justify-end">
              <a
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-accent hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                Open →
              </a>
              {page.status === "failed" && onRetry && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry(page.id);
                  }}
                  className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-300"
                >
                  Retry
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(page.id);
                  }}
                  className="text-xs font-medium text-red-700 hover:underline dark:text-red-300"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
