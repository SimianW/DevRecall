import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "DevRecall",
  description: "Local-first recall for technical browsing sessions.",
  version: "0.1.0",
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
  permissions: ["activeTab", "sidePanel", "scripting", "storage", "tabs"],
  host_permissions: ["http://*/*", "https://*/*"],
});
