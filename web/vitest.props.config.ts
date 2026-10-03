import { defineConfig } from "vitest/config";

// Stands alone: vitest does not merge vite.config.ts when given --config, and
// the jsdom setup file there must not run for the property suite, which talks
// to a real server from plain node.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/props/**/*.prop.ts"],
    setupFiles: [],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
