// /link-local-file opens the local-files picker, and the picked file lands
// as a Local copy:: link (a PDF renders its Open embed; any other file is a
// plain anchor). The e2e server seeds Papers/sample.pdf and Papers/notes.zip.
// Uses its own page and deletes it afterwards (the e2e DB is shared).
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const TITLE = "Link Local File E2E";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
}

const input = (page: Page) => page.locator("textarea.block-input");

async function openPicker(page: Page) {
  await input(page).fill("/link-local-file");
  await page.getByRole("option", { name: "link to local file…" }).click();
  const dialog = page.getByRole("dialog", { name: "Link a local file" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.afterEach(async ({ page }) => {
  await page.request.delete(`/api/page/${encodeURIComponent(TITLE)}`);
});

test("/link-local-file browses to a PDF and a search picks a zip", async ({ page }) => {
  await login(page);
  const created = await page.request.post("/api/pages", { data: { title: TITLE } });
  expect(created.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(TITLE)}`);
  await page.getByText("Click to start writing…").click();

  const dialog = await openPicker(page);
  await dialog.getByRole("option", { name: "Papers" }).click();
  await dialog.getByRole("option", { name: "sample.pdf" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();

  // A second block: reopen the picker, search, and pick with Enter.
  await page.locator(".block-text").last().click();
  await input(page).press("End");
  await input(page).press("Enter");
  const search = await openPicker(page);
  const box = search.getByRole("combobox", { name: "Search local files" });
  await box.fill("notes");
  await expect(search.getByRole("option", { name: /notes\.zip/ })).toBeVisible();
  await box.press("Enter");
  await expect(search).toHaveCount(0);

  const zip = page.getByRole("link", { name: "notes.zip" });
  await expect(zip).toHaveAttribute("href", "/api/local/Papers/notes.zip");
  await waitForServerText(page, TITLE, "Local copy:: [notes.zip](/api/local/Papers/notes.zip)");
});
