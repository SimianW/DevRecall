import { useState, type ReactNode } from "react";

import type { PageListItem } from "../../shared/types";

type CardPage = PageListItem & { excerpt?: string };

type PageCardProps = {
  page: CardPage;
  hasApiKey?: boolean;
  onAddAiFeatures?: (id: string) => void;
  onDelete?: (id: string) => void;
  onOpenSettings?: () => void;
  onRetry?: (id: string) => void;
};

const STATUS_LABELS: Record<PageListItem["status"], string> = {
  pending: "Saving locally...",
  keyword_ready: "Saved locally",
  enriching: "Adding AI features...",
  ready: "Ready",
  failed: "Local save failed",
};

function StatusBadge({ status }: { status: PageListItem["status"] }) {
  const isFailure = status === "failed";
  const isReady = status === "ready" || status === "keyword_ready";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        isFailure
          ? "bg-red-500/10 text-red-700 dark:text-red-300"
          : isReady
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
      }`}
    >
      {STATUS_LABELS[status]}
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

function DetailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/55">
        {label}
      </h3>
      {children}
    </section>
  );
}

function formatLabel(value: string) {
  return value
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function PageCard({
  page,
  hasApiKey = false,
  onAddAiFeatures,
  onDelete,
  onOpenSettings,
  onRetry,
}: PageCardProps) {
  const [expanded, setExpanded] = useState(false);

  const savedDate = new Date(page.savedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const hasSummary = page.summary.trim().length > 0;
  const cardText = hasSummary ? page.summary : (page.excerpt ?? "");
  const detailLabel = hasSummary ? "Summary" : "Excerpt";
  const canAddAiFeatures = page.status === "keyword_ready";
  const addAiLabel = page.enrichmentError ? "Retry AI features" : "Add AI features";

  return (
    <article className="rounded-lg border border-default bg-surface-raised px-4 py-3 text-foreground shadow-sm">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <h2 className="font-serif text-sm font-semibold text-foreground">{page.title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <StatusBadge status={page.status} />
          <span className="text-xs text-foreground/40">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      <p className="mt-1 text-xs text-foreground/60">{page.domain}</p>

      {cardText && (
        <p
          className={`mt-2 text-sm leading-6 text-foreground/75 ${expanded ? "" : "line-clamp-2"}`}
        >
          {cardText}
        </p>
      )}

      {page.enrichmentError && page.status === "keyword_ready" && (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300">
          AI processing failed: {page.enrichmentError}
        </p>
      )}

      {canAddAiFeatures && (
        <div className="mt-3 rounded-md border border-default/80 bg-foreground/[0.025] p-3">
          <button
            type="button"
            disabled={!hasApiKey || !onAddAiFeatures}
            onClick={() => onAddAiFeatures?.(page.id)}
            className="text-xs font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-foreground/35 disabled:no-underline"
          >
            {addAiLabel}
          </button>
          <p className="mt-1 text-xs text-foreground/55">
            Sends this page to OpenAI for a summary, tags, and semantic search.
          </p>
          {!hasApiKey && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="mt-1 text-xs font-medium text-accent hover:underline"
            >
              Settings
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div className="mt-4 flex flex-col gap-4 border-t border-default/80 pt-4">
          {cardText && (
            <DetailGroup label={detailLabel}>
              <p className="text-sm leading-6 text-foreground/75">{cardText}</p>
            </DetailGroup>
          )}

          {page.status === "failed" && page.localSaveError && (
            <p className="text-xs text-red-700 dark:text-red-300">{page.localSaveError}</p>
          )}

          {page.topics.length > 0 && (
            <DetailGroup label="Topics">
              <div className="flex flex-wrap gap-2">
                {page.topics.map((topic) => (
                  <Chip key={topic} label={topic} />
                ))}
              </div>
            </DetailGroup>
          )}

          {page.technologies.length > 0 && (
            <DetailGroup label="Technologies">
              <div className="flex flex-wrap gap-2">
                {page.technologies.map((technology) => (
                  <Chip key={technology} label={technology} />
                ))}
              </div>
            </DetailGroup>
          )}

          <div className="grid gap-3 border-t border-default/70 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="grid gap-3 sm:grid-cols-3">
              <DetailGroup label="Platform">
                <p className="text-sm text-foreground/75">{formatLabel(page.platform)}</p>
              </DetailGroup>
              <DetailGroup label="Type">
                <p className="text-sm text-foreground/75">{formatLabel(page.contentType)}</p>
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
                onClick={(event) => event.stopPropagation()}
              >
                Open →
              </a>
              {page.status === "failed" && onRetry && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
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
                  onClick={(event) => {
                    event.stopPropagation();
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
