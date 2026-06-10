import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["node_modules", ".claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/lib/**/*.ts",
        "src/worker/handlers.ts",
        "src/worker/services/**/*.ts",
        "src/worker/llm/**/*.ts",
        "src/worker/settings/**/*.ts",
      ],
    },
  },
});
