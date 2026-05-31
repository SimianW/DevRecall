import { useState } from "react";

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

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
      {label}
    </span>
  );
}

export function PageCard({ page }: PageCardProps) {
  const [expanded, setExpanded] = useState(false);

  const savedDate = new Date(page.savedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-3">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <h2 className="text-sm font-semibold text-slate-900">{page.title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <StatusBadge status={page.status} />
          <span className="text-xs text-slate-400">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      <p className="mt-1 text-xs text-slate-500">{page.domain}</p>

      <p className={`mt-2 text-sm text-slate-600 ${expanded ? "" : "line-clamp-2"}`}>
        {page.summary || page.url}
      </p>

      {expanded && (
        <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3">
          {page.topics.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {page.topics.map((t) => (
                <Chip key={t} label={t} />
              ))}
            </div>
          )}

          {page.technologies.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {page.technologies.map((t) => (
                <Chip key={t} label={t} />
              ))}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">
              {page.sourceType.replace(/_/g, " ")} · {savedDate}
            </span>
            <a
              href={page.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Open →
            </a>
          </div>
        </div>
      )}
    </article>
  );
}
