// Back and forward put the window where each history entry left it, although
// PageView shows "Loading…" (one viewport tall) before the page arrives.
import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";
import type { RawTitle } from "../src/api/brands";

const LINES = 80;

const lineUid = (prefix: string, i: number) => `${prefix}${i.toString().padStart(3, "0")}`;

async function fill(page: Page, title: RawTitle, prefix: string, link?: string) {
  const ops = Array.from({ length: LINES }, (_, i) => ({
    op: "create", uid: lineUid(prefix, i),
    page_title: title, parent_uid: null, order_idx: i,
    text: i === LINES - 5 && link ? link : `${prefix} line ${i}`,
  }));
  const res = await page.request.post("/api/ops", { data: {
    client_id: "e2e-history-scroll",
    batch_id: `e2e-history-scroll-${prefix}-${Date.now()}`, ops } });
  expect(res.ok()).toBeTruthy();
}

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

test("back and forward restore each page's scroll offset", async ({ page, ownPage, scratch }) => {
  const stamp = Date.now().toString(36);
  const first = ownPage.title;
  const second = await scratch.open("second ");
  await fill(page, second, `hsb${stamp}`);
  await fill(page, first, `hsa${stamp}`, `go to [[${second}]]`);
  await page.goto(`/page/${encodeURIComponent(first)}`);

  const link = page.locator(".page-link", { hasText: second });
  await link.scrollIntoViewIfNeeded();
  const firstOffset = await scrollY(page);
  expect(firstOffset).toBeGreaterThan(500);
  await link.click();
  await expect(page.locator("h1.page-title")).toContainText(second);
  await expect.poll(() => scrollY(page)).toBe(0);

  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(() => scrollY(page)).toBe(700);

  await page.goBack();
  await expect(page.locator("h1.page-title")).toContainText(first);
  await expect.poll(() => scrollY(page)).toBe(firstOffset);

  await page.goForward();
  await expect(page.locator("h1.page-title")).toContainText(second);
  await expect.poll(() => scrollY(page)).toBe(700);
});

test("back to a #block entry restores where the reader left it, not the block",
     async ({ page, ownPage, scratch }) => {
  const stamp = Date.now().toString(36);
  const first = ownPage.title;
  const second = await scratch.open("second ");
  const target = lineUid(`hsa${stamp}`, 3);
  await fill(page, first, `hsa${stamp}`, `go to [[${second}]]`);
  await fill(page, second, `hsb${stamp}`, `see ((${target}))`);
  await page.goto(`/page/${encodeURIComponent(second)}`);

  const ref = page.locator(".block-ref", { hasText: `hsa${stamp} line 3` });
  await ref.scrollIntoViewIfNeeded();
  await ref.click();
  await expect(page).toHaveURL(new RegExp(`#${target}$`));
  await expect(page.locator(`[data-uid="${target}"]`)).toBeInViewport();

  const link = page.locator(".page-link", { hasText: second });
  await link.scrollIntoViewIfNeeded();
  const offset = await scrollY(page);
  expect(offset).toBeGreaterThan(500);
  await link.click();
  await expect(page.locator("h1.page-title")).toContainText(second);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#${target}$`));
  await expect.poll(() => scrollY(page)).toBe(offset);
  await expect(page.locator(`[data-uid="${target}"]`)).not.toHaveClass(/flash-target/);
});
