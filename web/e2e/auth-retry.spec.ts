// A session that expires mid-drain (cleared cookie, rotated secret) must not
// lose the edit it was delivering: the durable batch retries instead of
// being poisoned, and the repair that runs after login must not delete it.
//
// A cleared cookie is not simulated with context.setOffline: the websocket
// only re-checks auth at its own handshake, not per frame, and the queue's
// HTTP delivery is gated on that socket's "connected" status (see
// useSocketLifecycle.ts) -- taking the whole network down would also kill
// the socket and its reconnect would then itself 403 on the cleared cookie,
// so the queue would never come back online to attempt the POST that is
// supposed to 401. Blocking only /api/ops leaves the socket (and therefore
// queue.setOnline) untouched, matching how a session really expires: the
// already-open socket stays up while the next HTTP POST's cookie re-check
// fails.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
}

const input = (page: Page) => page.locator("textarea.block-input");

test("a session that expires mid-drain retries and delivers instead of losing the edit",
async ({ page, context }) => {
  test.setTimeout(60_000);

  // the local replica must finish its initial sync before the queue is
  // trusted to hold a durable edit
  const snapshot = page.waitForResponse("**/api/sync/snapshot");
  const changes = page.waitForResponse("**/api/sync/changes*");
  await login(page);
  await snapshot;
  await changes;

  const title = `Auth Retry E2E ${Date.now()}`;
  // Created through the client's own search bar, not a raw server call: this
  // writes the page into the local replica and delivers it before the block
  // below is installed, so only the test's own edit is held back by it.
  await page.getByLabel("Search").fill(title);
  await page.locator(".search-result", { hasText: `Create page "${title}"` }).click();
  await expect(page.locator("h1.page-title")).toHaveText(title);
  await expect(page.locator(".ws-banner")).toHaveCount(0);

  try {
    let blockOps = true;
    let blockedAttempts = 0;
    await page.route("**/api/ops", (route) => {
      if (blockOps) { blockedAttempts += 1; void route.abort(); return; }
      void route.continue();
    });

    await page.getByText("Click to start writing…").click();
    await input(page).fill("edit survives a session expiry");
    await input(page).press("Escape"); // blur: flushes the draft op
    // the socket stays "connected" throughout (only /api/ops is blocked), so
    // no offline/syncing banner renders; wait on the queue's own retry
    // instead, proof the edit is sitting durable rather than delivered
    await expect.poll(() => blockedAttempts).toBeGreaterThan(0);

    // the session is gone before the drain's next retry gets a chance
    await context.clearCookies();
    // the desktop unload guard may fire a beforeunload confirm on the
    // full-page /login navigation below if the in-memory lane is non-empty
    page.on("dialog", (dialog) => { void dialog.accept(); });
    blockOps = false;

    // apiFetch's onUnauthorized redirects unconditionally on 401
    await page.waitForURL("**/login", { timeout: 20_000 });
    await page.fill("#pw", PASSWORD);
    await page.click("text=log in");
    await page.waitForURL("**/");

    // retained, not poisoned: the retry after login delivers it
    await waitForServerText(page, title, "edit survives a session expiry");
  } finally {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});
