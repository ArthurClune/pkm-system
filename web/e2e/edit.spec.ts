import { type Page } from "@playwright/test";
import { expect, test, trackResponses } from "./fixtures";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  // wait until the websocket is up (editing unpauses)
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

// the End key does not move the caret in text fields on macOS — set it
const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

test("core editing loop: create, split, indent, persist, link, backlink", async ({ page }) => {
  await login(page);
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();

  // fresh DB: today is empty -> the start-writing affordance
  await today.getByText("Click to start writing…").click();
  await input(page).fill("first block");
  await input(page).press("Enter"); // split at end -> new empty sibling
  await input(page).fill("second block");
  await input(page).press("Tab");   // indent under "first block"
  // wait for the indent to settle: the textarea remounts under the new
  // parent and a post-paint effect re-focuses it and resets the caret —
  // pressing End before that effect races it (toBeVisible is not enough)
  await expect(page.locator(".block-children textarea.block-input")).toBeFocused();

  // link via [[ autocomplete: New page row picked with Enter
  await caretToEnd(page);
  await input(page).pressSequentially(" [[E2E Target");
  await page.getByRole("option", { name: /New page: E2E Target/ }).click();
  await expect(input(page)).toHaveValue("second block [[E2E Target]]");
  await input(page).press("Escape"); // blur: flushes the draft op

  // persisted across a full reload, structure intact
  await page.reload();
  const day = page.locator(".journal-day").first();
  await expect(day.locator(".block-text", { hasText: "first block" })).toBeVisible();
  const child = day.locator(".block-children .block-text", { hasText: "second block" });
  await expect(child).toBeVisible();

  // the link navigates; the daily page shows up as a backlink
  await child.getByRole("link", { name: "E2E Target" }).click();
  await expect(page).toHaveURL(/\/page\/E2E%20Target/);
  await expect(page.locator(".backlinks")).toContainText("Linked references (1)");
  await expect(page.locator(".backlink-text")).toContainText("second block");
});

test("edits broadcast live to a second client", async ({ browser, badResponses }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  trackResponses(ctxA, badResponses);
  trackResponses(ctxB, badResponses);
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a);
  await login(b);

  const dayA = a.locator(".journal-day").first();
  await dayA.locator(".block-text").first().click();
  await caretToEnd(a);
  await input(a).press("Enter");
  await input(a).fill("sync-check-42");
  await input(a).press("Escape"); // flush

  // b sees it without reloading (websocket patch)
  await expect(b.locator(".journal-day").first())
    .toContainText("sync-check-42", { timeout: 10_000 });

  await ctxA.close();
  await ctxB.close();
});
