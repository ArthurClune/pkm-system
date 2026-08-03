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

/** Creates a uniquely-named page via POST (never writes to today's journal,
 * which other specs assume stays empty) and navigates to it. */
async function createAndVisitPage(page: Page, title: string) {
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator("h1.page-title")).toHaveText(title);
}

async function toggleStamps(page: Page) {
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Show timestamps/ }).click();
  await page.keyboard.press("Escape");
}

test("the page menu toggles a stamp column that survives a reload", async ({ page }) => {
  const title = `BlockStamps${Date.now()}`;
  await login(page);
  await createAndVisitPage(page, title);

  // A block to stamp: type one into the freshly created (empty) page.
  await page.getByText("Click to start writing…").click();
  await page.locator("textarea.block-input").fill("a block with a date");
  await expect(page.locator(".block-row")).toHaveCount(1);

  // Off by default.
  await expect(page.locator(".block-stamp")).toHaveCount(0);

  await toggleStamps(page);
  const stamp = page.locator(".block-stamp").first();
  await expect(stamp).toBeVisible();
  // Just created, so it lands in the freshest band with a real date on it.
  await expect(stamp).toHaveClass(/block-stamp-week/);
  await expect(stamp).toHaveText(/^\d{1,2} [A-Z][a-z]{2} \d{2}$/);

  await page.reload();
  await expect(page.locator("h1.page-title")).toHaveText(title);
  await expect(page.locator(".block-stamp").first()).toBeVisible();

  // The menu item reflects the stored preference after the reload.
  await page.getByRole("button", { name: "Page menu" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Show timestamps/ }))
    .toHaveAttribute("aria-checked", "true");
});
