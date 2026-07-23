import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// pkm-a1e4: Ctrl-O (open a [[page reference]] under the caret) and
// Ctrl-Shift-O (open it in the sidebar) used to jump straight to the target
// title without creating it, so a reference typed this session -- whose
// caret never left the [[...]] token, holding the debounced autosave that
// would otherwise get-or-create it (pkm-xlah) -- 404d on arrival. Both must
// create the page first.

const PASSWORD = "e2e-pw";
const input = (page: Page) => page.locator("textarea.block-input");

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

async function createPage(page: Page, title: string) {
  const response = await page.request.post("/api/pages", { data: { title } });
  expect(response.ok()).toBeTruthy();
}

const afterPaint = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve())));

/** Types a brand-new "[[target]]" reference via the bracket auto-pair (the
 * same key sequence a real user types) and leaves the caret right before the
 * auto-inserted closing "]]" -- mid-token, so the draft flush stays held and
 * the target page is never created server-side by this point. */
async function typeUnflushedRef(page: Page, target: string) {
  await expect(input(page)).toBeFocused();
  await input(page).press("[");
  await afterPaint(page);
  await input(page).press("[");
  await afterPaint(page);
  await input(page).pressSequentially(target);
  await expect(input(page)).toHaveValue(`[[${target}]]`);
}

test("Ctrl-O creates a not-yet-existing referenced page before navigating (pkm-a1e4)", async ({ page }) => {
  const stamp = Date.now();
  const source = `RefOpenSource${stamp}`;
  const target = `RefOpenTarget${stamp}`;
  await login(page);
  await createPage(page, source);
  await page.goto(`/page/${encodeURIComponent(source)}`);
  await page.getByText("Click to start writing…").click();
  await typeUnflushedRef(page, target);

  // the target genuinely has no row yet: the flush that would create it is
  // held while the caret sits inside the ref
  const before = await page.request.get(`/api/page/${encodeURIComponent(target)}`);
  expect(before.status()).toBe(404);

  await input(page).press("Control+o");
  await expect(page).toHaveURL(new RegExp(`/page/${encodeURIComponent(target)}$`));
  await expect(page.locator("h1.page-title")).toHaveText(target);

  const after = await page.request.get(`/api/page/${encodeURIComponent(target)}`);
  expect(after.ok()).toBeTruthy();
});

test("Ctrl-Shift-O creates a not-yet-existing referenced page and opens it in the sidebar (pkm-a1e4)", async ({ page }) => {
  const stamp = Date.now();
  const source = `RefOpenSidebarSource${stamp}`;
  const target = `RefOpenSidebarTarget${stamp}`;
  await login(page);
  await createPage(page, source);
  await page.goto(`/page/${encodeURIComponent(source)}`);
  await page.getByText("Click to start writing…").click();
  await typeUnflushedRef(page, target);

  const before = await page.request.get(`/api/page/${encodeURIComponent(target)}`);
  expect(before.status()).toBe(404);

  await input(page).press("Control+Shift+O");
  await expect(page.locator(".sidebar-panel-title")).toHaveText(target);
  // the main pane stays on the source page -- Ctrl-Shift-O never navigates it
  await expect(page).toHaveURL(new RegExp(`/page/${encodeURIComponent(source)}$`));

  const after = await page.request.get(`/api/page/${encodeURIComponent(target)}`);
  expect(after.ok()).toBeTruthy();
});
