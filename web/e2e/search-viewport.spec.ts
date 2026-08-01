import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// pkm-vszf: the top-bar search field grows to a fixed 320px on focus
// (pkm-0wg9). With the other top-bar controls present that pushes the input
// past 320px/390px phone viewports -- jsdom can't lay out flexbox, so this
// is the only place that catches real overflow (src/styles.test.ts pins the
// CSS declarations that fix it).

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

/** Creates a uniquely-named page via POST (never writes to today's
 * journal) and navigates to it -- a page route puts the full top bar
 * (title + search + help + page menu) on screen at once. */
async function createAndVisitPage(page: Page, title: string) {
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator("h1.page-title")).toHaveText(title);
}

for (const viewport of [{ width: 320, height: 660 }, { width: 390, height: 844 }]) {
  test(`focused search stays within a ${viewport.width}px viewport (pkm-vszf)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const stamp = Date.now();
    await login(page);
    await createAndVisitPage(page, `SearchViewport${viewport.width}_${stamp}`);

    const input = page.getByRole("textbox", { name: "Search" });
    await input.focus();
    await expect(input).toBeFocused();
    // .top-bar-search-input animates its width over 0.15s (pkm-0wg9); reading
    // the box immediately catches an in-flight value that's still short of
    // the final (overflowing, pre-fix) width and would pass either way.
    await page.waitForTimeout(300);

    const box = await input.boundingBox();
    if (!box) throw new Error("search input has no bounding box");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  });
}
