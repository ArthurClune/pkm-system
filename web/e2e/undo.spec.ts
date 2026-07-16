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

const input = (page: Page) => page.locator("textarea.block-input");

// the End key does not move the caret in text fields on macOS — set it
const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

// Markers unique to this spec: other e2e specs share the same server/DB
// (single worker, serial run) and already leave content on today's page
// (e.g. edit.spec.ts's "second block"), so plain words like "second" would
// collide via getByText's substring match.
const FIRST = "undo-alpha-pkm7q14";
const SECOND = "undo-beta-pkm7q14";

test("undo and redo across text and structure", async ({ page }) => {
  await login(page);
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();

  // block-row count is not assumed to start at 0: other specs share the DB
  // and run first, so track the delta this test introduces instead of an
  // absolute count.
  const baseline = await today.locator(".block-row").count();

  // append a fresh sibling after whatever's already on today's page
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }

  // one flushed text step
  await input(page).fill(FIRST);
  await input(page).press("Escape"); // blur flushes the draft
  await expect(page.locator(".ws-banner")).toHaveCount(0);
  await expect(today.locator(".block-row")).toHaveCount(baseline + 1);

  // one structural step: split into a second block
  await today.getByText(FIRST).click();
  await input(page).press("End");
  await input(page).press("Enter");
  await input(page).fill(SECOND);
  await input(page).press("Escape");
  await expect(today.locator(".block-row")).toHaveCount(baseline + 2);

  // undo the SECOND text flush -> empty second block remains
  await page.keyboard.press("ControlOrMeta+z");
  await expect(today.getByText(SECOND, { exact: true })).toHaveCount(0);
  await expect(today.locator(".block-row")).toHaveCount(baseline + 2);

  // undo the split -> back to one block
  await page.keyboard.press("ControlOrMeta+z");
  await expect(today.locator(".block-row")).toHaveCount(baseline + 1);

  // redo the split
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(today.locator(".block-row")).toHaveCount(baseline + 2);

  // redo the text
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(today.getByText(SECOND, { exact: true })).toBeVisible();

  // survives the server round-trip
  await expect(page.locator(".ws-banner")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".journal-day").first().getByText(SECOND, { exact: true }))
    .toBeVisible();
});
