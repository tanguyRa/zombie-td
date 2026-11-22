import { defineConfig } from "vitest/config";

// Node unit tests (no browser, no network). Playwright tests live in e2e/.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
