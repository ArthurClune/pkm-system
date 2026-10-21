import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs only the *.watchdog.ts fixture (the default unit run does not match
// it) under the setup file both real suites share; orphanWatchdog.test.ts
// drives it in a subprocess and kills that subprocess mid-test.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    environment: "node",
    include: ["*.watchdog.ts"],
    setupFiles: [join(here, "../../src/test-guards.ts")],
    pool: "forks",
  },
});
