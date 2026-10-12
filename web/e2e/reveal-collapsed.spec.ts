// Following a ((uid)) ref to a block inside a collapsed subtree: the hidden
// row is not rendered, so the target page expands every collapsed ancestor
// hiding it (persisted as set_collapsed ops, like any toggle), then scrolls
// to and flashes the block as it does for any other #uid.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const created: string[] = [];
test.afterEach(async ({ page }) => {
  for (const title of created.splice(0)) {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});

async function createPage(page: Page, title: string) {
  created.push(title);
  expect((await page.request.post("/api/pages", { data: { title } })).ok()).toBeTruthy();
}

async function postOps(page: Page, ops: unknown[]) {
  const res = await page.request.post("/api/ops", { data: {
    client_id: "e2e-reveal", batch_id: `e2e-reveal-${Date.now()}-${Math.random()}`, ops } });
  expect(res.ok()).toBeTruthy();
}

test("following a block ref into a collapsed subtree expands it and lands on the block",
     async ({ page }) => {
  await login(page);
  const stamp = Date.now().toString(36);
  const target = `Reveal Target ${stamp}`;
  const source = `Reveal Source ${stamp}`;
  const parentUid = `rvl${stamp}par`;
  const childUid = `rvl${stamp}kid`;
  await createPage(page, target);
  await createPage(page, source);
  await postOps(page, [
    { op: "create", uid: parentUid, page_title: target, parent_uid: null,
      order_idx: 0, text: "collapsed parent" },
    { op: "create", uid: childUid, page_title: target, parent_uid: parentUid,
      order_idx: 0, text: `hidden child ${stamp}` },
    { op: "set_collapsed", uid: parentUid, collapsed: true },
    { op: "create", uid: `rvl${stamp}src`, page_title: source, parent_uid: null,
      order_idx: 0, text: `see ((${childUid}))` },
  ]);

  await page.goto(`/page/${encodeURIComponent(source)}`);
  await page.locator(".block-ref", { hasText: `hidden child ${stamp}` }).click();

  await expect(page).toHaveURL(new RegExp(`#${childUid}$`));
  const row = page.locator(`[data-uid="${childUid}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/flash-target/);
  await expect(row).toBeInViewport();

  await expect.poll(async () => {
    const res = await page.request.get(`/api/page/${encodeURIComponent(target)}`);
    const body = await res.json() as { blocks: { uid: string; collapsed: boolean }[] };
    return body.blocks.find((b) => b.uid === parentUid)?.collapsed;
  }).toBe(false);
});
