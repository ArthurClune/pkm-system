import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // every spec shares the single e2e_serve.py server and its one DB (and
  // most edit the same journal page), so parallel workers interfere
  workers: 1,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8975" },
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: {
    command: "cd ../server && uv run python tests/e2e_serve.py",
    url: "http://127.0.0.1:8975/healthz",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
