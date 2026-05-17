import { SurfaceShell } from "../ui/components";

type PopupProps = {
  openSidePanel?: () => void;
};

function defaultOpenSidePanel() {
  if (typeof chrome === "undefined" || !chrome.sidePanel?.open) {
    return;
  }

  void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
}

export function Popup({ openSidePanel = defaultOpenSidePanel }: PopupProps) {
  return (
    <SurfaceShell title="DevRecall">
      <div className="flex min-h-[180px] flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-slate-900">Current page</p>
          <p className="mt-1 truncate text-sm text-slate-500">
            Ready for extension setup
          </p>
        </div>

        <button
          type="button"
          disabled
          className="w-full rounded-md bg-slate-200 px-3 py-2 text-sm font-medium text-slate-500"
        >
          Save this page
        </button>

        <p className="text-xs text-slate-500">Set API key in settings</p>

        <button
          type="button"
          onClick={openSidePanel}
          className="mt-auto w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white"
        >
          Open library
        </button>
      </div>
    </SurfaceShell>
  );
}
