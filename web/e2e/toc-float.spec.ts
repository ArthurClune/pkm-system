// On a wide main pane with the right sidebar closed, the first {{toc}}
// floats in a sticky column beside the outline and its row shows a marker;
// opening the sidebar or narrowing the window puts the card back in place.
import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";
import type { RawTitle } from "../src/api/brands";

test.use({ viewport: { width: 1440, height: 900 } });

const floating = (page: Page) => page.locator("aside.toc-float");
const floatingLinks = (page: Page) => floating(page).locator("a.toc-link");
const lists = (page: Page) => page.locator(".main-pane nav.toc");
const marker = (page: Page) => page.locator(".main-pane .toc-marker");

// The page links to itself, so a shift-click opens a sidebar panel without
// creating a second page for the fixture to clean up.
async function seed(page: Page, title: RawTitle) {
  const stamp = Date.now().toString(36);
  const texts = [`{{toc}}`, `see [[${title}]]`,
    ...Array.from({ length: 60 }, (_, i) => `filler ${i}`)];
  const ops: Record<string, unknown>[] = [
    { op: "create", uid: `tf${stamp}h1`, page_title: title, parent_uid: null,
      order_idx: 0, text: "Intro", heading: 1 },
    ...texts.map((text, i) => ({
      op: "create", uid: `tf${stamp}b${i}`, page_title: title,
      parent_uid: null, order_idx: i + 1, text })),
    { op: "create", uid: `tf${stamp}h2`, page_title: title, parent_uid: null,
      order_idx: texts.length + 1, text: "Later", heading: 2 },
  ];
  const res = await page.request.post("/api/ops", { data: {
    client_id: "e2e-toc-float", batch_id: `e2e-toc-float-${stamp}`, ops } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
}

test("the toc floats beside a wide page and gives way to the sidebar",
     async ({ page, ownPage }) => {
  await seed(page, ownPage.title);

  await expect(floatingLinks(page)).toHaveText(["Intro", "Later"]);
  await expect(marker(page)).toBeVisible();
  await expect(lists(page)).toHaveCount(1);

  // A long list scrolls inside its column rather than being cut off.
  const style = await floating(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { overflowY: s.overflowY, maxHeight: s.maxHeight };
  });
  expect(style.overflowY).toBe("auto");
  expect(style.maxHeight).not.toBe("none");

  // Sticky: after a long scroll the column is still at the top of the view.
  await page.evaluate(() => window.scrollBy(0, 1500));
  await expect.poll(async () => (await floating(page).boundingBox())?.y)
    .toBeLessThanOrEqual(40);
  expect((await floating(page).boundingBox())!.y).toBeGreaterThanOrEqual(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await floatingLinks(page).filter({ hasText: "Later" }).click();
  await expect(page.locator("h2.block-text", { hasText: "Later" }))
    .toBeInViewport();

  // The sidebar takes priority: the card comes back where the block sits.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".main-pane .block-text a.page-link").first()
    .click({ modifiers: ["Shift"] });
  await expect(page.locator("aside.sidebar")).toBeVisible();
  await expect(floating(page)).toHaveCount(0);
  await expect(marker(page)).toHaveCount(0);
  await expect(lists(page).locator("a.toc-link")).toHaveText(["Intro", "Later"]);

  await page.locator(".panel-close").click();
  await expect(floatingLinks(page)).toHaveText(["Intro", "Later"]);

  // Too narrow for a column beside the text: the card again.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(floating(page)).toHaveCount(0);
  await expect(lists(page).locator("a.toc-link")).toHaveText(["Intro", "Later"]);
});
