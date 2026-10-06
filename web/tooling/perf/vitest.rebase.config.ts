import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot } from "vite";
import { defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));

// Stands alone, like vitest.props.config.ts: vitest does not merge
// vite.config.ts when given --config, and the jsdom setup file there must not
// run for the rebase scenario, which talks to the perf fixture server from
// plain node. The root is web/, wherever the command runs from.
//
// The scenario imports the replica from $PERF_WEB_ROOT, which on a
// merge-base run is another worktree outside this one. Vite refuses to load
// a file outside server.fs.allow ("Failed to load url ... Does the file
// exist?"), and naming any allow entry drops the default workspace root, so
// both are listed.
export default defineConfig({
  root: webRoot,
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(webRoot),
        ...(process.env.PERF_WEB_ROOT ? [path.resolve(process.env.PERF_WEB_ROOT)] : []),
      ],
    },
  },
  test: {
    environment: "node",
    include: ["tooling/perf/rebase.perf.ts"],
    setupFiles: [],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
