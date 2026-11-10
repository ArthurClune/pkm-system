import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";
import { waitForServerText } from "./server-state";

const input = (page: Page) => page.locator("textarea.block-input");

/** Write a fresh top-level block on the page the test owns, which starts
 * empty, and wait for the server to hold it. */
async function writeFirstBlock(page: Page, title: string, text: string) {
  await page.getByText("Click to start writing…").click();
  await input(page).fill(text);
  await input(page).press("Escape"); // blur: flushes the draft op
  await waitForServerText(page, title, text);
}

// the pages the tests below create through links or renames; a 404 is fine
test.afterEach(async ({ page }) => {
  for (const title of ["Rename Src g0t5", "Rename Dst g0t5", "Merge A g0t5", "Merge B g0t5"]) {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});

test("rename a page updates the title, URL, and referencing text", async ({ page, ownPage }) => {
  await writeFirstBlock(page, ownPage.title, "marker-g0t5 [[Rename Src g0t5]]");

  await page.getByRole("link", { name: "Rename Src g0t5" }).click();
  await expect(page).toHaveURL(/\/page\/Rename%20Src%20g0t5/);

  await page.locator("h1.page-title").click();
  await page.locator("input.page-title-input").fill("Rename Dst g0t5");
  await page.locator("input.page-title-input").press("Enter");

  await expect(page).toHaveURL(/\/page\/Rename%20Dst%20g0t5/);
  await expect(page.locator("h1.page-title")).toHaveText("Rename Dst g0t5");

  // the referencing block's [[link]] text was rewritten server-side
  await page.goto(`/page/${encodeURIComponent(ownPage.title)}`);
  await expect(page.locator("main"))
    .toContainText("marker-g0t5 [[Rename Dst g0t5]]".replace(/\[\[|\]\]/g, ""));
  await expect(page.getByRole("link", { name: "Rename Dst g0t5" })).toBeVisible();
});

test("renaming onto an existing page merges after confirm", async ({ page, ownPage }) => {
  await writeFirstBlock(page, ownPage.title, "merge-links-g0t5 [[Merge A g0t5]] [[Merge B g0t5]]");

  // put distinguishable content on the source page
  await page.getByRole("link", { name: "Merge A g0t5" }).click();
  await page.getByText("Click to start writing…").click();
  await input(page).fill("content-from-a-g0t5");
  await input(page).press("Escape");
  await waitForServerText(page, "Merge A g0t5", "content-from-a-g0t5");

  await page.locator("h1.page-title").click();
  await page.locator("input.page-title-input").fill("Merge B g0t5");
  await page.locator("input.page-title-input").press("Enter");
  // The merge confirm is an in-app dialog now (window.confirm is
  // suppressed by iPadOS Safari in standalone mode), not a native one.
  // Scoped to the dialog: an unscoped query can also match the page-title
  // edit button, since that button is legitimately named by its content and
  // this page is titled "Merge A g0t5".
  await page.getByRole("alertdialog").getByRole("button", { name: "Merge" }).click();

  // landed on the merged page, source content appended
  await expect(page).toHaveURL(/\/page\/Merge%20B%20g0t5/);
  await expect(page.locator(".page")).toContainText("content-from-a-g0t5");

  // the source page is gone: its link in the referencing page now points at B
  await page.goto(`/page/${encodeURIComponent(ownPage.title)}`);
  await expect(page.locator("main").locator(".block-text", { hasText: "merge-links-g0t5" })
    .getByRole("link", { name: "Merge B g0t5" })).toHaveCount(2);
});
