import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// pkm-57mo: the center pane (.main-pane) is meant to widen into whatever
// room a missing/collapsed sidebar frees up, rather than sitting at a fixed
// max-width regardless of how much of the window is actually available.
// This asserts the four left-nav x right-sidebar combinations produce
// strictly increasing pane widths as space frees up, without pinning to
// exact pixel caps (those are a CSS implementation detail, not the
// contract) -- see .app.nav-collapsed / .app.no-sidebar in styles.css.

const PASSWORD = "e2e-pw";
const input = (page: Page) => page.locator("textarea.block-input");

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

async function waitForText(page: Page, pageTitle: string, text: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/page/${encodeURIComponent(pageTitle)}`);
    if (!response.ok()) return false;
    const payload = await response.json() as { blocks: { text: string }[] };
    return payload.blocks.some((block) => block.text === text);
  }, { timeout: 20_000 }).toBe(true);
}

async function mainPaneWidth(page: Page): Promise<number> {
  const box = await page.locator(".main-pane").boundingBox();
  if (!box) throw new Error(".main-pane has no bounding box");
  return box.width;
}

test("center pane widens as the left nav collapses and the right sidebar closes (pkm-57mo)", async ({ page }) => {
  const stamp = Date.now();
  const source = `PageWidthSource${stamp}`;
  const target = `PageWidthTarget${stamp}`;
  await login(page);
  await createPage(page, target);
  await createPage(page, source);

  await page.goto(`/page/${encodeURIComponent(source)}`);
  await expect(page.locator("h1.page-title")).toHaveText(source);
  await page.getByText("Click to start writing…").click();
  await input(page).fill(`see [[${target}]]`);
  await input(page).press("Escape");
  await waitForText(page, source, `see [[${target}]]`);

  // 1. left nav open, right sidebar absent (the default: no page stacked).
  const leftOpenRightAbsent = await mainPaneWidth(page);

  // 2. open the right sidebar -- both open, the narrowest/baseline case.
  await page.getByRole("link", { name: target }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".sidebar-panel-title")).toHaveText(target);
  const leftOpenRightOpen = await mainPaneWidth(page);

  // 3. collapse the left nav too -- right sidebar still open.
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.locator("nav.left-nav")).toHaveClass(/collapsed/);
  const leftCollapsedRightOpen = await mainPaneWidth(page);

  // 4. close the stacked panel -- left nav collapsed, right sidebar absent:
  // the widest case, both freed at once.
  await page.getByRole("button", { name: "close panel" }).click();
  const leftCollapsedRightAbsent = await mainPaneWidth(page);

  // Removing either sidebar (independently) widens the pane vs. the
  // both-open baseline.
  expect(leftOpenRightAbsent).toBeGreaterThan(leftOpenRightOpen);
  expect(leftCollapsedRightOpen).toBeGreaterThan(leftOpenRightOpen);

  // Freeing the second sidebar on top of the first widens it further still.
  expect(leftCollapsedRightAbsent).toBeGreaterThan(leftOpenRightAbsent);
  expect(leftCollapsedRightAbsent).toBeGreaterThan(leftCollapsedRightOpen);

  // Both-freed is the overall widest of the four combinations.
  expect(leftCollapsedRightAbsent).toBeGreaterThan(leftOpenRightOpen);
});
