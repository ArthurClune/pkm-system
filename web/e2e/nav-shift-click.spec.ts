import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// pkm-10ah: shift-clicking a pinned page in the left nav fell through to the
// browser's native shift-click and opened the whole app in a second window --
// two live copies of the same page, which the sync layer then warns about.
// Only a real browser can prove the new window is gone; jsdom has no popups.

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

test("shift-clicking a non-page nav destination does nothing at all (pkm-10ah)",
     async ({ page, context }) => {
  await login(page);
  await page.goto("/current-work");
  await expect(page.locator(".top-bar-title")).toHaveText("Current Work");

  const popups: Page[] = [];
  context.on("page", (p) => popups.push(p));

  // no page sits behind these, so the click is swallowed outright
  for (const name of ["Daily Notes", "Files", "Settings"]) {
    await page.locator("#left-nav").getByRole("link", { name }).click({ modifiers: ["Shift"] });
    await expect(page).toHaveURL(/\/current-work$/);
  }
  await expect(page.locator(".top-bar-title")).toHaveText("Current Work");
  await expect(page.locator(".sidebar-panel")).toHaveCount(0);
  expect(popups).toHaveLength(0);
});

test("shift-clicking a pinned left-nav page opens the sidebar, not a second window (pkm-10ah)",
     async ({ page, context }) => {
  const title = `NavShiftClick${Date.now()}`;
  await login(page);
  const created = await page.request.post("/api/pages", { data: { title } });
  expect(created.ok()).toBeTruthy();
  const pinned = await page.request.post("/api/sidebar", { data: { title } });
  expect(pinned.ok()).toBeTruthy();
  const entryId = (await pinned.json()).id;

  try {
    await page.goto("/");
    const popups: Page[] = [];
    context.on("page", (p) => popups.push(p));

    await page.locator(".nav-sidebar-entries")
      .getByRole("link", { name: title })
      .click({ modifiers: ["Shift"] });

    await expect(page.locator(".sidebar-panel-title")).toHaveText(title);
    // the main pane stays on Daily Notes: shift-click opens, never navigates
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    expect(popups).toHaveLength(0);
  } finally {
    // the whole run shares one DB; don't leave a pinned entry behind for the
    // next spec's left nav
    await page.request.delete(`/api/sidebar/${entryId}`);
  }
});
