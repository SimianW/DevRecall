import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
  },
  build: {
    emptyOutDir: true,
    sourcemap: true,
  },
});
