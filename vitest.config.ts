import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    hookTimeout: 30000,
    testTimeout: 30000,
    environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
  },
});
