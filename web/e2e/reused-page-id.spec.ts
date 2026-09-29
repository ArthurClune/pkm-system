// A page id the server deletes and hands to a new page (SQLite reuses the
// highest freed INTEGER PRIMARY KEY) must reach a replica as delete-then-
// create: the server's refs cascade dropped every ref to the old page, and
// the replica has to drop them too, or the new page's Linked references
// (read from the replica while offline) list blocks that linked to the old
// one. Server writes go through a separate API context so they land while
// the browser is offline.
import { type Page, type Response, type WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

type FeedBody = { blocks?: { uid: string }[]; pages?: { id: number; title: string }[] };

const changesMatching = (page: Page, match: (body: FeedBody) => boolean) =>
  page.waitForResponse(async (response: Response) => {
    if (!response.url().includes("/api/sync/changes")) return false;
    if (!response.ok()) return false;
    try {
      return match(await response.json() as FeedBody);
    } catch {
      return false;
    }
  }, { timeout: 20_000 });

async function openFromSearch(page: Page, title: string) {
  await page.getByLabel("Search").fill(title);
  await page.locator(".search-result", { hasText: title }).first().click();
  await expect(page.locator("h1.page-title")).toHaveText(title);
}

test("a page id reused while this tab is offline leaves no stale linked references",
  async ({ page, context, playwright, baseURL }) => {
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
    const goOffline = async () => {
      offline = true;
      await context.setOffline(true);
      for (const ws of live.splice(0)) await ws.close();
      await expect(page.locator(".ws-banner")).toContainText("Offline");
    };

    const snapshot = page.waitForResponse("**/api/sync/snapshot");
    const changes = page.waitForResponse("**/api/sync/changes*");
    await login(page);
    await snapshot;
    await changes;

    const api = await playwright.request.newContext({
      baseURL, storageState: await context.storageState(),
    });
    const stamp = Date.now();
    const source = `ReuseSrc${stamp}`;
    const target = `ReuseTgt${stamp}`;
    const reborn = `ReuseNew${stamp}`;
    const srcUid = `e2ereusesrc${stamp}`.slice(0, 32);
    const markerUid = `e2ereusemrk${stamp}`.slice(0, 32);
    try {
      expect((await api.post("/api/pages", { data: { title: source } })).ok()).toBeTruthy();
      const created = await api.post("/api/pages", { data: { title: target } });
      expect(created.ok()).toBeTruthy();
      const targetId = (await created.json() as { id: number }).id;

      const sourceSynced = changesMatching(
        page, (body) => (body.blocks ?? []).some((b) => b.uid === srcUid));
      const ops = await api.post("/api/ops", { data: {
        client_id: "e2e-reuse", batch_id: `e2e-reuse-src-${stamp}`,
        ops: [{ op: "create", uid: srcUid, page_title: source, parent_uid: null,
                order_idx: 0, text: `see [[${target}]]` }],
      } });
      expect(ops.ok()).toBeTruthy();
      await sourceSynced;

      // control: offline, the target's backlinks come from the replica
      await goOffline();
      await openFromSearch(page, target);
      await expect(page.locator(".backlinks")).toContainText("Linked references (1)");

      // the server deletes the target and a new page takes its id
      expect((await api.delete(`/api/page/${encodeURIComponent(target)}`)).ok())
        .toBeTruthy();
      const replaced = await api.post("/api/pages", { data: { title: reborn } });
      expect(replaced.ok()).toBeTruthy();
      expect((await replaced.json() as { id: number }).id).toBe(targetId);
      const marker = await api.post("/api/ops", { data: {
        client_id: "e2e-reuse", batch_id: `e2e-reuse-mrk-${stamp}`,
        ops: [{ op: "create", uid: markerUid, page_title: reborn, parent_uid: null,
                order_idx: 0, text: "reused marker" }],
      } });
      expect(marker.ok()).toBeTruthy();

      // reconnect; the new page reaches the replica with or without the
      // tombstone, so this wait holds on either
      const rebornSynced = changesMatching(
        page, (body) => (body.pages ?? []).some(
          (p) => p.id === targetId && p.title === reborn));
      offline = false;
      await context.setOffline(false);
      await expect(page.locator(".ws-banner")).toHaveCount(0, { timeout: 20_000 });
      await rebornSynced;

      // offline again, so the new page renders from the replica
      await goOffline();
      await openFromSearch(page, reborn);
      await expect(page.locator(".block-text", { hasText: "reused marker" })).toBeVisible();
      await expect(page.locator(".backlink-text")).toHaveCount(0);
    } finally {
      for (const title of [source, reborn, target]) {
        const r = await api.delete(`/api/page/${encodeURIComponent(title)}`);
        expect([200, 404]).toContain(r.status());
      }
      await api.dispose();
    }
  });
