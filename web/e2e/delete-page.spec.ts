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

/** Creates a uniquely-named page via POST (never writes to today's
 * journal, which other specs assume stays empty) and navigates to it. */
async function createAndVisitPage(page: Page, title: string) {
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator("h1.page-title")).toHaveText(title);
}

async function openPageMenu(page: Page) {
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitem", { name: "Delete page…" }).click();
}

// pkm-pe79: deleting a page used window.confirm() for the "are you sure"
// prompt, which iPadOS Safari silently no-ops in standalone/PWA mode --
// the dialog never appears and the delete never happens. The fix renders
// an in-app confirm dialog instead, which is exercisable headlessly (no
// native `confirm()`/`page.on("dialog")` involved at all), so this spec
// doubles as regression coverage for that iPad-only failure mode.
test("deleting a page shows an in-app confirm dialog naming the page", async ({ page }) => {
  const title = `DeletePageConfirm${Date.now()}`;
  await login(page);
  await createAndVisitPage(page, title);

  await openPageMenu(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(title);
});

test("cancelling the delete confirm leaves the page intact", async ({ page }) => {
  const title = `DeletePageCancel${Date.now()}`;
  await login(page);
  await createAndVisitPage(page, title);

  await openPageMenu(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // still on the page, and the server still has it
  await expect(page.locator("h1.page-title")).toHaveText(title);
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  expect(res.ok()).toBeTruthy();
});

test("confirming the delete dialog deletes the page and returns to the journal", async ({ page }) => {
  const title = `DeletePageConfirmed${Date.now()}`;
  await login(page);
  await createAndVisitPage(page, title);

  await openPageMenu(page);
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(/\/$/);
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  expect(res.status()).toBe(404);
});

test("Escape cancels the delete confirm dialog (keyboard accessibility)", async ({ page }) => {
  const title = `DeletePageEscape${Date.now()}`;
  await login(page);
  await createAndVisitPage(page, title);

  await openPageMenu(page);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await expect(page.locator("h1.page-title")).toHaveText(title);
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  expect(res.ok()).toBeTruthy();
});
