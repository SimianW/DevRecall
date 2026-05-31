import { defineManifest } from "@crxjs/vite-plugin";

import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "DevRecall",
  description: "Local-first recall for technical browsing sessions.",
  version: pkg.version,
  action: {
    default_title: "DevRecall",
    default_popup: "src/popup/index.html",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/worker/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["src/content/extract.ts"],
      run_at: "document_idle",
      all_frames: true,
    },
  ],
  commands: {
    "open-side-panel": {
      suggested_key: { default: "Ctrl+Shift+K", mac: "Command+Shift+K" },
      description: "Open the DevRecall side panel",
    },
  },
  permissions: ["activeTab", "sidePanel", "scripting", "storage", "tabs"],
  host_permissions: ["http://*/*", "https://*/*"],
});
