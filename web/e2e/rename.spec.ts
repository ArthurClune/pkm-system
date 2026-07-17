import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

/** Append a fresh top-level block to today's journal page (never assumes
 * an empty day: e2e specs share the DB). */
async function appendJournalBlock(page: Page, text: string) {
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
  await input(page).fill(text);
  await input(page).press("Escape"); // blur: flushes the draft op
  const title = await today.locator("h1.page-title").innerText();
  await waitForServerText(page, title, text);
}

test("rename a page updates the title, URL, and referencing text", async ({ page }) => {
  await login(page);
  await appendJournalBlock(page, "marker-g0t5 [[Rename Src g0t5]]");

  await page.getByRole("link", { name: "Rename Src g0t5" }).click();
  await expect(page).toHaveURL(/\/page\/Rename%20Src%20g0t5/);

  await page.locator("h1.page-title").click();
  await page.locator("input.page-title-input").fill("Rename Dst g0t5");
  await page.locator("input.page-title-input").press("Enter");

  await expect(page).toHaveURL(/\/page\/Rename%20Dst%20g0t5/);
  await expect(page.locator("h1.page-title")).toHaveText("Rename Dst g0t5");

  // the journal block's [[link]] text was rewritten server-side
  await page.goto("/");
  await expect(page.locator(".journal-day").first())
    .toContainText("marker-g0t5 [[Rename Dst g0t5]]".replace(/\[\[|\]\]/g, ""));
  await expect(page.getByRole("link", { name: "Rename Dst g0t5" })).toBeVisible();
});

test("renaming onto an existing page merges after confirm", async ({ page }) => {
  await login(page);
  await appendJournalBlock(page, "merge-links-g0t5 [[Merge A g0t5]] [[Merge B g0t5]]");

  // put distinguishable content on the source page
  await page.getByRole("link", { name: "Merge A g0t5" }).click();
  await page.getByText("Click to start writing…").click();
  await input(page).fill("content-from-a-g0t5");
  await input(page).press("Escape");
  await waitForServerText(page, "Merge A g0t5", "content-from-a-g0t5");

  page.on("dialog", (dialog) => void dialog.accept());
  await page.locator("h1.page-title").click();
  await page.locator("input.page-title-input").fill("Merge B g0t5");
  await page.locator("input.page-title-input").press("Enter");

  // landed on the merged page, source content appended
  await expect(page).toHaveURL(/\/page\/Merge%20B%20g0t5/);
  await expect(page.locator(".page")).toContainText("content-from-a-g0t5");

  // the source page is gone: its link in the journal now points at B
  await page.goto("/");
  const day = page.locator(".journal-day").first();
  await expect(day.locator(".block-text", { hasText: "merge-links-g0t5" })
    .getByRole("link", { name: "Merge B g0t5" })).toHaveCount(2);
});
