import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// PKM_API_PORT lets dev/verification runs proxy to a scratch server without
// touching 8974, which the production launchd service owns on this machine.
const apiTarget = `http://127.0.0.1:${process.env.PKM_API_PORT ?? "8974"}`;

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { assetsDir: "app-assets" },
  // sqlite-wasm must not be pre-bundled: its wasm asset URL resolution
  // breaks under dep optimization (upstream guidance)
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: {
    proxy: {
      "/api": { target: apiTarget, ws: true },
      "/assets": apiTarget,
      "/login": apiTarget,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    globals: false,
    exclude: ["e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test-helpers.ts",
        "src/replica/testDb.ts",
        "src/replica/worker.ts",
        "src/test-setup.ts",
        "src/main.tsx",
        "src/**/*.d.ts",
        "src/api/ops.ts",
        "src/api/payloads.ts",
      ],
      thresholds: {
        statements: 95,
        branches: 91,
        functions: 89,
        lines: 95,
      },
    },
  },
});
