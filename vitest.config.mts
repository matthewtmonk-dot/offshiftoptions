import { fileURLToPath } from "node:url";
import "dotenv/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // scripts/**/*.test.ts added only for the temporary schwab-evidence-diagnostic branch's own
    // sanitizer dry-run tests - never merged to main.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    restoreMocks: true,
  },
});
