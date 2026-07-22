// docs/keyboard.md rendered at /help (pkm-9jwr): the doc is the single
// source of truth, so this only checks that a couple of known lines make it
// to the page -- not the whole doc's content, which is the parser's job
// (see src/help/parseHelpMarkdown.test.ts).
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

test("/help renders the keyboard shortcut doc", async ({ page }) => {
  await login(page);
  await page.goto("/help");

  await expect(page.getByRole("heading", { level: 1, name: "Keyboard shortcuts" })).toBeVisible();
  const shortcutCell = page.getByText("Go to Daily Notes", { exact: false });
  await expect(shortcutCell).toBeVisible();
  await expect(shortcutCell.locator("xpath=ancestor::tr")).toContainText("Ctrl+Shift+D");
});

test("top-bar help button navigates to /help", async ({ page }) => {
  await login(page);
  await expect(page.locator(".journal-day").first()).toBeVisible();

  await page.getByRole("button", { name: "help" }).click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByRole("heading", { level: 1, name: "Keyboard shortcuts" })).toBeVisible();
  await expect(page.locator(".top-bar-title")).toHaveText("Help");
});
