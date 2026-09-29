// An edit made offline is durable in the replica's pending queue, so it
// survives the browser being closed before it was ever delivered: the next
// launch serves it from the replica while still offline, and delivers it
// once the network is back. A persistent context keeps the profile (OPFS,
// the service worker, the session cookie) across a real browser restart.
import { rmSync } from "node:fs";
import {
  type APIRequestContext, type BrowserContext, chromium, type Page,
  request, type WebSocketRoute,
} from "@playwright/test";
import { expect, test, trackResponses } from "./fixtures";

const PASSWORD = "e2e-pw";

/** Steers the context's app websocket: while `offline` new connections are
 * refused, and `drop()` closes the live ones so the client sees it. */
async function steerSocket(context: BrowserContext, startOffline: boolean) {
  const state = { offline: startOffline };
  const live: WebSocketRoute[] = [];
  await context.routeWebSocket(/\/api\/ws$/, (ws) => {
    if (state.offline) {
      void ws.close();
      return;
    }
    ws.connectToServer();
    live.push(ws);
  });
  return {
    async goOffline() {
      state.offline = true;
      await context.setOffline(true);
      for (const ws of live.splice(0)) await ws.close();
    },
    async goOnline() {
      state.offline = false;
      await context.setOffline(false);
    },
  };
}

async function serverTexts(api: APIRequestContext, title: string): Promise<string[]> {
  type Node = { text: string; children: Node[] };
  const flat = (bs: Node[]): string[] =>
    bs.flatMap((b) => [b.text, ...flat(b.children)]);
  const res = await api.get(`/api/page/${encodeURIComponent(title)}`);
  if (!res.ok()) return [];
  return flat((await res.json() as { blocks: Node[] }).blocks);
}

test("an edit made offline is delivered after the browser restarts",
async ({ badResponses }) => {
  test.setTimeout(90_000);
  const baseURL = test.info().project.use.baseURL;
  const profile = test.info().outputPath("profile");
  const stamp = Date.now();
  const title = `Offline Restart ${stamp}`;
  const text = `survives a restart ${stamp}`;
  let context: BrowserContext | null = null;
  let api: APIRequestContext | null = null;
  try {
    // -- session 1: online long enough to hydrate, then offline -------------
    context = await chromium.launchPersistentContext(profile, { baseURL });
    trackResponses(context, badResponses);
    let socket = await steerSocket(context, false);
    let page: Page = context.pages()[0] ?? await context.newPage();

    const snapshot = page.waitForResponse("**/api/sync/snapshot");
    const changes = page.waitForResponse("**/api/sync/changes*");
    await page.goto("/login");
    await page.fill("#pw", PASSWORD);
    await page.click("text=log in");
    await page.waitForURL("**/");
    await snapshot;
    await changes;
    // the relaunch boots offline, so the shell must be precached
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return navigator.serviceWorker.controller !== null;
    });
    api = await request.newContext({
      baseURL, storageState: await context.storageState(),
    });

    // the page goes through the client, so the replica holds it
    await page.getByLabel("Search").fill(title);
    await page.locator(".search-result", { hasText: `Create page "${title}"` }).click();
    await expect(page.locator("h1.page-title")).toHaveText(title);
    await expect.poll(async () =>
      (await api!.get(`/api/page/${encodeURIComponent(title)}`)).ok(),
    { timeout: 20_000 }).toBe(true);

    await socket.goOffline();
    const banner = page.locator(".ws-banner");
    await expect(banner).toContainText("Offline");
    await page.getByText("Click to start writing…").click();
    await page.locator("textarea.block-input").fill(text);
    await page.locator("textarea.block-input").press("Escape");
    // pending, and in the replica's durable queue rather than this tab's
    // memory: only that survives the browser closing
    await expect(banner).toContainText(/\d+ changes? pending/);
    await expect(banner).not.toContainText("only in memory");
    expect(await serverTexts(api, title)).not.toContain(text);

    await context.close();
    context = null;

    // -- session 2: a new browser on the same profile, still offline --------
    context = await chromium.launchPersistentContext(profile, {
      baseURL, offline: true,
    });
    trackResponses(context, badResponses);
    socket = await steerSocket(context, true);
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(`/page/${encodeURIComponent(title)}`);
    await expect(page.locator("h1.page-title")).toHaveText(title);
    await expect(page.locator(".block-text", { hasText: text })).toBeVisible();
    await expect(page.locator(".ws-banner")).toContainText(/\d+ changes? pending/);
    expect(await serverTexts(api, title)).not.toContain(text);

    // -- reconnect: the queue drains to the server ---------------------------
    await socket.goOnline();
    await expect.poll(() => serverTexts(api!, title), { timeout: 30_000 })
      .toContain(text);
    await expect(page.locator(".ws-banner")).toHaveCount(0, { timeout: 20_000 });
  } finally {
    if (api !== null) {
      await api.delete(`/api/page/${encodeURIComponent(title)}`);
      await api.dispose();
    }
    if (context !== null) await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
