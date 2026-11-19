// A bundle the server no longer serves shows the stale-build banner, and its
// Reload drops the service worker's caches but keeps the replica's OPFS
// files (a marker file stands in for them). The mismatch is made by
// rewriting X-Pkm-Build on API responses.
import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";

const API = /\/api\//;
const PASSWORD = "e2e-pw";

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

// Logs in itself: ownPage's wait for `.ws-banner` to clear would fail first
// on a mismatch, and this test should be the one that says why.
test("a matching build shows no banner", async ({ page, scratch }) => {
  const stamped = page.waitForResponse(
    (r) => API.test(r.url()) && r.headers()["x-pkm-build"] !== undefined);
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  const served = (await stamped).headers()["x-pkm-build"];
  const file = await (await page.request.get("/build-id.json")).json() as
    { build: string };
  expect(served).toBe(file.build);

  // the banner can only follow apiFetch reading a header, so wait for a
  // rendered page and a quiet network before asserting it never came
  const title = await scratch.open();
  await expect(page.locator("h1.page-title")).toHaveText(title);
  await page.waitForLoadState("networkidle");
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
