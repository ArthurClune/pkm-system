// Offline editing (pkm-y8p0/pkm-wptk): with the network down, the replica
// serves reads and edits queue durably; reconnecting drains the queue to
// the server. The websocket is steered through routeWebSocket so "offline"
// is deterministic — context.setOffline alone does not kill an open socket.
import { type Page, type WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

// the End key does not move the caret in text fields on macOS — set it
const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

const afterPaint = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve())));

test("offline: edit, create page, link, navigate; reconnect drains to server", async ({ page, context }) => {
  test.setTimeout(60_000);

  // Steer the app's websocket: while `offline` new connections are refused,
  // and closing the live routes makes the client see the drop immediately.
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

  // Replica hydration: bootstrap fetches the snapshot, flips to ready, then
  // pulls the changes feed once — after that the app can work offline.
  const snapshot = page.waitForResponse("**/api/sync/snapshot");
  const changes = page.waitForResponse("**/api/sync/changes*");
  await login(page);
  await snapshot;
  await changes;

  // -- go offline ----------------------------------------------------------
  offline = true;
  await context.setOffline(true);
  for (const ws of live.splice(0)) await ws.close();
  await expect(page.locator(".ws-banner")).toContainText("Offline");

  // edit a block on today's page (must not assume an empty day: specs share
  // the server DB)
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
  await input(page).fill("offline edit survives");
  await input(page).press("Escape"); // blur: flushes the draft op
  await expect(page.locator(".ws-banner")).toContainText(/\d+ changes? pending/);

  // create a page from the search bar; the shim serves the POST locally
  await page.getByLabel("Search").fill("Offline Target");
  await page.locator(".search-result", { hasText: 'Create page "Offline Target"' }).click();
  await expect(page).toHaveURL(/\/page\/Offline%20Target/);
  await expect(page.locator("h1.page-title")).toHaveText("Offline Target");

  // back on the daily page, [[ autocomplete offers the offline-created page
  await page.getByRole("link", { name: "Daily Notes" }).click();
  const marker = today.locator(".block-text", { hasText: "offline edit survives" });
  await marker.click();
  await caretToEnd(page);
  await input(page).pressSequentially(" ");
  await input(page).press("[");
  await afterPaint(page); // auto-pair caret restoration runs after paint
  await input(page).press("[");
  await afterPaint(page);
  await input(page).pressSequentially("Offline Tar");
  await page.getByRole("option", { name: "Offline Target", exact: true }).click();
  await expect(input(page)).toHaveValue("offline edit survives [[Offline Target]]");
  await input(page).press("Escape");

  // the link navigates offline; backlinks come from the replica
  await marker.getByRole("link", { name: "Offline Target" }).click();
  await expect(page).toHaveURL(/\/page\/Offline%20Target/);
  await expect(page.locator(".backlinks")).toContainText("Linked references (1)");
  await expect(page.locator(".backlink-text")).toContainText("offline edit survives");

  // search runs on the replica's FTS index while offline (pkm-blz2):
  // page-title hits and block hits over text typed THIS offline session
  await page.getByLabel("Search").fill("survives");
  const blockHit = page.locator(".search-result", { hasText: "offline edit survives" });
  await expect(blockHit).toBeVisible();
  await page.keyboard.press("Escape"); // dismiss without navigating
  await page.getByLabel("Search").fill("Offline Target");
  await expect(page.locator(".search-result").first()).toContainText("Offline Target");
  await page.keyboard.press("Escape");

  // -- reconnect ------------------------------------------------------------
  offline = false;
  await context.setOffline(false);
  // socket retries every 2s; the queue then drains and the indicator clears
  await expect(page.locator(".ws-banner")).toHaveCount(0, { timeout: 20_000 });

  // server state: the page created offline now exists with a real id, and
  // the daily-page edit (with its link) reached the server as a backlink
  const res = await page.request.get("/api/page/Offline%20Target");
  expect(res.ok()).toBeTruthy();
  const body = await res.json() as {
    page: { id: number; title: string };
    backlinks: { groups: { items: { text: string }[] }[] };
  };
  expect(body.page.id).toBeGreaterThan(0);
  const texts = body.backlinks.groups.flatMap((g) => g.items.map((i) => i.text));
  expect(texts).toContain("offline edit survives [[Offline Target]]");

  // a full reload (online) shows the same state from the server
  await page.reload();
  await expect(page.locator("h1.page-title")).toHaveText("Offline Target");
  await expect(page.locator(".backlink-text")).toContainText("offline edit survives");
});
