// Cold start offline (pkm-xnnh): the service worker precaches the app
// shell, so a hard reload with no network boots the SPA; the replica
// serves content, runtime-cached assets render, uncached ones show a
// placeholder.
import { type Page, type WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

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
  const pageTitle = await today.locator("h1.page-title").innerText();
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

  // the image renders online (and is now in the SW's runtime cache)
  const img = page.locator("img.asset-image");
  await expect(img).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLImageElement>("img.asset-image");
    return el !== null && el.naturalWidth > 0;
  });

  // the offline reload below reads from the replica, so the flushed edit
  // must be durably enqueued first. Server delivery implies exactly that —
  // drain() only POSTs rows it reads back out of the replica — and unlike
  // the render assertions above it actually waits for the flush (pkm-57n9).
  await waitForServerText(page, pageTitle, `shell smoke ![pic](${url})`);

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

// Mermaid stays a never-online capability under the explicit raw-byte budget
// (budgets.json mermaidOwnedBytes): its whole lazy chunk family is precached
// by the service worker, so a diagram renders with no network at all. This
// guards the budget task's promise that the Mermaid exception buys genuine
// offline rendering, not just a smaller eager bundle.
test("mermaid renders offline from the precached chunk", async ({ page, context }) => {
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
  await login(page);
  await snapshot;

  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });

  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();
  const pageTitle = await today.locator("h1.page-title").innerText();
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }
  // A fenced mermaid block lives in a single block's multi-line text; the
  // renderer tokenizes it into a code-block(lang="mermaid") -> MermaidDiagram.
  await input(page).fill("```mermaid\ngraph TD\nA-->B\n```");
  await input(page).press("Escape");

  // renders online: this loads and (via the precache glob) caches the mermaid
  // chunk family in the service worker.
  await expect(page.locator(".mermaid-diagram svg")).toBeVisible({ timeout: 30_000 });

  // the offline reload must find the diagram block in the replica: wait for
  // the flush to become durable (server delivery implies the local enqueue
  // landed — see the first test) before cutting the network (pkm-57n9)
  await waitForServerText(page, pageTitle, "```mermaid\ngraph TD\nA-->B\n```");

  // -- cold start with no network -------------------------------------------
  offline = true;
  await context.setOffline(true);
  for (const ws of live.splice(0)) await ws.close();
  await page.reload();

  await expect(page.locator(".journal-day").first()).toBeVisible();
  await expect(page.locator(".ws-banner")).toContainText("Offline");
  // the diagram re-renders with zero network: proof the mermaid chunk came
  // from the SW precache, not a live fetch.
  await expect(page.locator(".mermaid-diagram svg")).toBeVisible({ timeout: 30_000 });
});
