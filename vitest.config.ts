import { defineConfig } from "vitest/config";
import path from "path";

// Vitest owns the unit tests under `src`. `.dev/` holds vendored upstream
// checkouts and `tests/` holds node:test scripts; neither is a vitest suite.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
