// Cold start offline (pkm-xnnh): the service worker precaches the app
// shell, so a hard reload with no network boots the SPA; the replica
// serves content, runtime-cached assets render, uncached ones show a
// placeholder.
import { type Page, type WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";

// 1x1 red pixel
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64");

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");
const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

test("cold start offline: SW shell + replica content + asset cache", async ({ page, context }) => {
  test.setTimeout(60_000);

  let offline = false;
  const live: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/ws$/, (ws) => {
    if (offline) {
      void ws.close();
      return;
    }
    ws.connectToServer();
    live.push(ws);
  });

  const snapshot = page.waitForResponse("**/api/sync/snapshot");
  const changes = page.waitForResponse("**/api/sync/changes*");
  await login(page);
  await snapshot;
  await changes;

  // the SW must control the page before the image loads, or the runtime
  // cache never sees it
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });

  // upload an image and embed it on today's page
  const upload = await page.request.post("/api/assets", {
    multipart: { file: { name: "pic.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(upload.ok()).toBeTruthy();
  const { url } = await upload.json() as { url: string };

  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }
  await input(page).fill(`shell smoke ![pic](${url})`);
  await input(page).press("Escape");
  await expect(page.locator(".ws-banner")).toHaveCount(0); // flushed

  // the image renders online (and is now in the SW's runtime cache)
  const img = page.locator("img.asset-image");
  await expect(img).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLImageElement>("img.asset-image");
    return el !== null && el.naturalWidth > 0;
  });

  // -- cold start with no network -------------------------------------------
  offline = true;
  await context.setOffline(true);
  for (const ws of live.splice(0)) await ws.close();
  await page.reload(); // the SW serves /index.html from the precache

  // shell booted, replica serves the journal, indicator reports offline
  await expect(page.locator(".journal-day").first()).toBeVisible();
  await expect(page.locator(".ws-banner")).toContainText("Offline");
  await expect(page.locator(".journal-day").first()).toContainText("shell smoke");

  // the viewed asset comes from the SW cache
  await expect(page.locator("img.asset-image")).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLImageElement>("img.asset-image");
    return el !== null && el.naturalWidth > 0;
  });

  // an asset never viewed online cannot load: labelled placeholder
  const day = page.locator(".journal-day").first();
  await day.locator(".block-text").first().click();
  await caretToEnd(page);
  await input(page).press("Enter");
  await input(page).fill("![ghost](/assets/0000000000000000000000000000000000000000000000000000000000000000/ghost.png)");
  await input(page).press("Escape");
  await expect(page.getByText(/image unavailable offline/)).toBeVisible();
});
