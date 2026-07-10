import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// PKM_API_PORT lets dev/verification runs proxy to a scratch server without
// touching 8974, which the production launchd service owns on this machine.
const apiTarget = `http://127.0.0.1:${process.env.PKM_API_PORT ?? "8974"}`;

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { assetsDir: "app-assets" },
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
  },
});
