// A bundle the server no longer serves shows the stale-build banner, and its
// Reload drops the service worker's caches but keeps the replica's OPFS
// files (a marker file stands in for them). The mismatch is made by
// rewriting X-Pkm-Build on API responses.
import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";

const API = /\/api\//;

const OPFS_MARKER = "e2e-stale-build-marker";

/** Whether the marker file is at the OPFS root, beside the replica's pool. */
function opfsMarkerExists(page: Page): Promise<boolean> {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }, OPFS_MARKER);
}

test("a matching build shows no banner", async ({ page, ownPage }) => {
  void ownPage;
  const response = page.waitForResponse(
    (r) => API.test(r.url()) && r.request().method() === "GET");
  await page.reload();
  expect((await response).headers()["x-pkm-build"]).toMatch(/^[A-Za-z0-9-]+$/);
  await expect(page.locator(".stale-build")).toHaveCount(0);
});

test("a different build shows the banner, and Reload clears the shell " +
     "but keeps the replica", async ({ page, ownPage }) => {
  void ownPage;
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });
  await page.evaluate(() => caches.open("e2e-marker"));
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(name, { create: true });
  }, OPFS_MARKER);
  expect(await opfsMarkerExists(page)).toBe(true);

  await page.route(API, async (route) => {
    const real = await route.fetch();
    await route.fulfill({
      response: real,
      headers: { ...real.headers(), "x-pkm-build": "other" },
    });
  });
  await page.reload();
  const banner = page.locator(".stale-build");
  await expect(banner).toHaveText(/A newer version of pkm is available\./);
  await page.unroute(API);

  await banner.getByRole("button", { name: "Reload" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.locator(".journal-day").first()).toBeVisible();
  await expect(page.locator(".stale-build")).toHaveCount(0);
  expect(await page.evaluate(() => caches.has("e2e-marker"))).toBe(false);
  expect(await opfsMarkerExists(page)).toBe(true);
  await page.evaluate(async (name) => {
    await (await navigator.storage.getDirectory()).removeEntry(name);
  }, OPFS_MARKER);
});
