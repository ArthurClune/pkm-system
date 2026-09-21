// A Local copy:: value written as a link to /api/local/... renders the
// in-app PDF viewer once its Open button is clicked (click-to-load, so a
// page of many papers fetches nothing on render -- pkm-pv7w), and a non-PDF
// local link stays a plain new-tab anchor (pkm-g1ep). Uses its own page so
// it never touches the journal.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
}

const input = (page: Page) => page.locator("textarea.block-input");

test("local pdf link embeds the viewer on Open; local zip link is a plain anchor", async ({ page }) => {
  await login(page);
  const createRes = await page.request.post("/api/pages", { data: { title: "Local Docs E2E" } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto("/page/Local%20Docs%20E2E");

  await page.getByText("Click to start writing…").click();
  await input(page).fill("Local copy:: [sample.pdf](/api/local/Papers/sample.pdf)");
  await input(page).press("Enter");
  await input(page).fill("Local copy:: [notes.zip](/api/local/Papers/notes.zip)");
  await input(page).press("Escape");

  // deferred: nothing fetched until Open is clicked
  const open = page.getByRole("button", { name: "Open", exact: true });
  await expect(open).toBeVisible();
  await expect(page.locator(".pdf-frame")).toHaveCount(0);
  await open.click();
  await expect(page.locator(".pdf-frame")).toBeVisible();
  await expect(page.locator(".pdf-page-indicator")).toHaveText("Page 1 of 3");
  // the click stayed inside the embed: the block did not re-enter edit mode
  await expect(input(page)).toHaveCount(0);

  const zip = page.getByRole("link", { name: "notes.zip" });
  await expect(zip).toHaveAttribute("href", "/api/local/Papers/notes.zip");
  await expect(zip).toHaveAttribute("target", "_blank");

  // the file itself is served with the expected headers
  const res = await page.request.get("/api/local/Papers/notes.zip");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
});

test("a missing local file is a 404, not a 500", async ({ page }) => {
  await login(page);
  const res = await page.request.get("/api/local/Papers/nope.pdf");
  expect(res.status()).toBe(404);
});
