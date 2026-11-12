import { defineConfig } from "vitest/config";

// Stands alone: vitest does not merge vite.config.ts when given --config, and
// the jsdom setup file there must not run for the property suite, which talks
// to a real server from plain node. test-guards.ts is jsdom-free and shared.
//
// One file at a time, since every suite shares one server, and each file in a
// fresh process. A process shared by every file hands each one whatever the
// files before it left behind: a poll still running lands its timers on a
// later file's fake clock, and vitest's end-of-file restore of every spy can
// put back a fake setTimeout whose clock is gone, after which no timer in the
// process fires and the run hangs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/props/**/*.prop.ts"],
    setupFiles: ["src/test-guards.ts", "src/props/setup.ts"],
    testTimeout: 1_200_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
  },
});
