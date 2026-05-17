import type { ReactNode } from "react";

type SurfaceShellProps = {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function SurfaceShell({ title, actions, children }: SurfaceShellProps) {
  return (
    <main className="min-h-screen bg-panel text-ink">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-base font-semibold tracking-normal">{title}</h1>
        {actions ? (
          <div className="flex items-center gap-2">{actions}</div>
        ) : null}
      </header>
      <div className="px-4 py-4">{children}</div>
    </main>
  );
}
