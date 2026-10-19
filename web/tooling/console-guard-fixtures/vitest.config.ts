import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs only the *.guard.ts fixtures (the default unit run does not match
// them) under the same setup file as the real suite; consoleGuard.test.ts
// drives it in a subprocess and reads the verdicts.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    environment: "jsdom",
    include: ["*.guard.ts"],
    setupFiles: [join(here, "../../src/test-setup.ts")],
  },
});
