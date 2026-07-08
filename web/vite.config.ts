import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { assetsDir: "app-assets" },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8974",
      "/assets": "http://127.0.0.1:8974",
      "/login": "http://127.0.0.1:8974",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    globals: false,
  },
});
