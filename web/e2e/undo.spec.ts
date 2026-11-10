import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";
import { waitForServerText } from "./server-state";

const input = (page: Page) => page.locator("textarea.block-input");

// the End key does not move the caret in text fields on macOS — set it
const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

// Markers unique to this spec so plain words cannot collide via getByText's
// substring match.
const FIRST = "undo-alpha-pkm7q14";
const SECOND = "undo-beta-pkm7q14";

test("undo and redo across text and structure", async ({ page, ownPage }) => {
  const today = page.locator("main");
  await expect(today).toBeVisible();
  const pageTitle = ownPage.title;

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
  await caretToEnd(page);
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

  // survives the server round-trip: wait for the server's own copy of the
  // page to contain the redone text before reloading. A ".ws-banner" check
  // here would be vacuous — while connected, pending>0 renders no banner at
  // all (see server-state.ts), so it never actually waits for the
  // final redo batch to reach the server, and reload() can race it.
  await waitForServerText(page, pageTitle, SECOND);
  await page.reload();
  await expect(page.locator("main").getByText(SECOND, { exact: true }))
    .toBeVisible();
});
