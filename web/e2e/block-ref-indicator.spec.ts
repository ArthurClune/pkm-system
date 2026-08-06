import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// pkm-d31f: a referenced block shows an incoming-reference count badge in
// the right gutter; clicking it pops up the referencing locations, and an
// entry navigates to the referencing block (hash scroll + flash).

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

async function createPage(page: Page, title: string) {
  const response = await page.request.post("/api/pages", { data: { title } });
  expect(response.ok()).toBeTruthy();
}

test("badge shows the incoming count and its popover navigates", async ({ page }) => {
  const stamp = Date.now();
  const target = `RefBadgeTarget${stamp}`;
  const source = `RefBadgeSource${stamp}`;
  const targetUid = `e2ed31ftgt${stamp}`.slice(0, 32);
  const sourceUid = `e2ed31fsrc${stamp}`.slice(0, 32);
  await login(page);
  await createPage(page, target);
  await createPage(page, source);
  const ops = await page.request.post("/api/ops", { data: {
    client_id: "e2e-d31f",
    batch_id: `e2e-d31f-${stamp}`,
    ops: [
      { op: "create", uid: targetUid, page_title: target,
        parent_uid: null, order_idx: 0, text: "the referenced block" },
      { op: "create", uid: sourceUid, page_title: source,
        parent_uid: null, order_idx: 0, text: `see ((${targetUid})) here` },
    ],
  } });
  expect(ops.ok()).toBeTruthy();

  await page.goto(`/page/${encodeURIComponent(target)}`);
  const badge = page.locator(".block-ref-badge");
  await expect(badge).toHaveText("1");
  await expect(badge).toHaveAccessibleName("1 reference");

  await badge.click();
  const popover = page.getByRole("dialog", { name: "References" });
  await expect(popover.getByText(source)).toBeVisible();
  await expect(popover.getByText("the referenced block")).toBeVisible(); // the ((ref)) resolves inline

  // the badge sits at the right edge of this full-width row, so this also
  // covers pkm-7iv7: the popover must be clamped fully inside the viewport
  const popBox = await popover.boundingBox();
  const viewport = page.viewportSize();
  expect(popBox!.x).toBeGreaterThanOrEqual(0);
  expect(popBox!.x + popBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(popBox!.y).toBeGreaterThanOrEqual(0);
  expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(viewport!.height);

  // click the item's top-left corner, not its center: the center lands on
  // the inline ((ref)) span, which is its own link back to the target
  await popover.locator(".backlink-item").click({ position: { x: 10, y: 10 } });
  await expect(page).toHaveURL(
    new RegExp(`/page/${encodeURIComponent(source)}#${sourceUid}$`));
  await expect(page.getByRole("dialog", { name: "References" })).toHaveCount(0);
  // navigation lands on the referencing block (not the target), which
  // scrolls into view and flashes -- same hash-scroll contract asset links
  // rely on (web/e2e/assistant-asset-link.spec.ts).
  await expect(page.locator(`[data-uid="${sourceUid}"]`)).toHaveClass(/flash-target/);

  // Escape-dismiss on a fresh open
  await page.goto(`/page/${encodeURIComponent(target)}`);
  await page.locator(".block-ref-badge").click();
  await expect(page.getByRole("dialog", { name: "References" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "References" })).toHaveCount(0);
});
