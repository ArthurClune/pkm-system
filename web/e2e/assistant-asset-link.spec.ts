// Clickable /assets/<sha>/<filename> URLs in assistant replies -- pkm-gdi5.
// FakeEngine's default scenario replies "echo: <user text>" (see
// server/tests/fake_engine.py), so sending the asset URL as the message is
// enough to get it rendered by the assistant panel. No real /api/assets
// upload is needed: AssetLink resolves via GET /api/search on the sha, and
// only falls back to opening the raw URL when no block references it -- a
// path this spec deliberately avoids by seeding a referencing block first.
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

const askInput = (page: Page) =>
  page.getByRole("region", { name: "Assistant" }).getByPlaceholder(/ask about your notes/i);

test("clicking an asset link in an assistant reply opens the referencing block; shift-click opens it in the sidebar", async ({ page }) => {
  await login(page);

  const stamp = Date.now();
  const pageTitle = `AssetLinkTarget${stamp}`;
  const uid = `al${stamp}`;
  const sha = "f".repeat(64);
  const filename = "IMG_0868.jpeg";
  const assetUrl = `/assets/${sha}/${filename}`;

  const createPage = await page.request.post("/api/pages", { data: { title: pageTitle } });
  expect(createPage.ok()).toBeTruthy();

  const opsResponse = await page.request.post("/api/ops", { data: {
    client_id: "e2e-gdi5",
    batch_id: `e2e-gdi5-${stamp}`,
    ops: [{
      op: "create", uid, page_title: pageTitle, parent_uid: null,
      order_idx: 0, text: `Chart source: ${assetUrl}`,
    }],
  } });
  expect(opsResponse.ok()).toBeTruthy();

  // sanity: the block is actually findable by sha before we rely on it below
  const search = await page.request.get(`/api/search?q=${sha}&exact=1`);
  expect((await search.json()).blocks).toEqual([
    expect.objectContaining({ uid, page_title: pageTitle }),
  ]);

  await page.goto("/");
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("region", { name: "Assistant" });
  await expect(panel).toBeVisible();

  await askInput(page).fill(assetUrl);
  await askInput(page).press("Enter");
  // the reply renders as "echo: " (text) + the asset-link anchor (filename
  // only, not the full URL) -- assert on the link itself, not the raw text.
  const link = panel.getByRole("link", { name: filename });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("title", assetUrl);

  await link.click();
  await expect(page).toHaveURL(new RegExp(`/page/${encodeURIComponent(pageTitle)}#${uid}$`));
  await expect(page.locator(`[data-uid="${uid}"]`)).toHaveClass(/flash-target/);

  // shift-click the SAME link (the panel survives navigation) -> sidebar
  await link.click({ modifiers: ["Shift"] });
  await expect(page.locator(".sidebar-panel-title")).toHaveText(pageTitle);
  // the main pane is undisturbed by the shift-click
  await expect(page).toHaveURL(new RegExp(`/page/${encodeURIComponent(pageTitle)}#${uid}$`));
});
