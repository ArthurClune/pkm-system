import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";
import { budgetPlugin, precacheBudgetTransform } from "./tooling/viteBudgetPlugin";

// PKM_API_PORT lets dev/verification runs proxy to a scratch server without
// touching 8974, which the production launchd service owns on this machine.
const apiTarget = `http://127.0.0.1:${process.env.PKM_API_PORT ?? "8974"}`;

export default defineConfig({
  plugins: [
    react(),
    // Offline app shell (spec section 5): precache the built SPA so a cold
    // start works with no network; runtime-cache viewed uploads from
    // /assets/ with an LRU cap. /api is NEVER cached — reads route through
    // the replica shim when offline, and the sync protocol must always see
    // real responses.
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "pkm",
        short_name: "pkm",
        description: "Personal knowledge management",
        theme_color: "#1a1a2e",
        background_color: "#1a1a2e",
        display: "standalone",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        // the sqlite wasm binary must be precached or the replica cannot
        // start offline
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Hard raw-byte/entry ceiling on the offline-shell precache: fails the
        // build if the final Workbox manifest exceeds budgets.json.
        manifestTransforms: [precacheBudgetTransform],
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: "/index.html",
        // /login is a server page; /assets and /api are data, not app shell
        navigateFallbackDenylist: [/^\/api/, /^\/assets/, /^\/login/],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && url.pathname.startsWith("/assets/"),
            handler: "CacheFirst",
            options: {
              cacheName: "pkm-assets",
              expiration: { maxEntries: 400, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
    // Runs last so its generateBundle sees the final emitted app output; a
    // material bundle regression (eager entry / largest asset / total /
    // Mermaid-owned bytes) fails the build.
    budgetPlugin(),
  ],
  base: "/",
  build: {
    assetsDir: "app-assets",
    // Vite's advisory >500kB chunk-size warning is superseded by the hard
    // raw-byte budgets in tooling/budgets.json (enforced by budgetPlugin()
    // above, which fails the build); set just above the current largest
    // chunk (largestAssetBytes: 907990 raw, ~887kB) so the advisory warning
    // stays silent while the real guard still fails the build on regression.
    chunkSizeWarningLimit: 900,
  },
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
