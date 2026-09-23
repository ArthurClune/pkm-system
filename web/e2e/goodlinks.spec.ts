// /goodlinks resolves the parent block's URL against GoodLinks (stubbed by
// server/tests/fake_goodlinks_server.py), inserts the Local copy:: link, and
// clicking that link opens the sandboxed reader. A URL the stub does not
// know is saved there first. Uses its own page and deletes it afterwards
// (the e2e DB is shared across specs).
import { createHash } from "node:crypto";
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

// server/tests/fake_goodlinks_server.py's seeded id and its POST /links id
// derivation (hashlib.md5(url.encode()).hexdigest()) -- waitForServerText
// matches a whole block's text, so the expected string has to be exact.
const ARTICLE_ID = "0123456789abcdef0123456789abcdef";
const stubLinkId = (url: string) => createHash("md5").update(url).digest("hex");

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

async function freshPage(page: Page, prefix: string): Promise<string> {
  const title = `${prefix} ${Date.now()}`;
  const res = await page.request.post("/api/pages", { data: { title } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText("Click to start writing…").click();
  return title;
}

async function linkThenChildGoodlinks(page: Page, url: string) {
  await input(page).fill(`[Article](${url})`);
  await input(page).press("Enter");
  await input(page).press("Tab"); // child of the link block
  await input(page).fill("/goodlinks");
  await page.getByRole("option", { name: "link to goodlinks copy" }).click();
}

test("/goodlinks links a saved page and the reader shows the sanitised article", async ({ page }) => {
  await login(page);
  let title = "";
  try {
    title = await freshPage(page, "Goodlinks E2E");
    await linkThenChildGoodlinks(page, "https://example.com/e2e-article");

    // exact: true -- the fresh page's own title ("Goodlinks E2E …") also
    // matches "Goodlinks" by substring via its page-title-edit button.
    const open = page.getByRole("button", { name: "Goodlinks", exact: true });
    await expect(open).toBeVisible();
    await expect(page.getByText("Local copy")).toBeVisible();
    // the block was given up by the pick, so no textarea remains
    await expect(input(page)).toHaveCount(0);

    await open.click();
    const dialog = page.getByRole("dialog", { name: "E2E Article" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link", { name: "original" }))
      .toHaveAttribute("href", "https://example.com/e2e-article");
    await expect(dialog.getByText("saved 13 Feb 2025")).toBeVisible();

    const frame = dialog.locator("iframe.goodlinks-reader-frame");
    await expect(frame).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    const srcdoc = await frame.getAttribute("srcdoc");
    expect(srcdoc).toContain("Archived article body for e2e.");
    expect(srcdoc).not.toContain("<script");
    await expect(frame.contentFrame().getByText("Archived article body for e2e.")).toBeVisible();
    await expect(page).toHaveTitle(/^(?!pwned)/);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();

    // The Tab press above is a move op; wait for the server's own copy of
    // the page to have the final edit before the finally block deletes it,
    // or the delete can land between the move's apply and its broadcast
    // (an in-flight ops batch racing page deletion -- pkm-h7jb-style).
    await waitForServerText(page, title, `Local copy:: [Goodlinks](/api/goodlinks/${ARTICLE_ID})`);
  } finally {
    if (title) await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});

test("/goodlinks saves an unknown URL to GoodLinks and reports it", async ({ page }) => {
  await login(page);
  let title = "";
  try {
    title = await freshPage(page, "Goodlinks Save E2E");
    const url = `https://example.com/new-${Date.now()}`;
    await linkThenChildGoodlinks(page, url);
    await expect(page.locator(".editor-notice[role='status']")).toHaveText(/Saved to Goodlinks/);
    await expect(page.getByRole("button", { name: "Goodlinks", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.locator(".editor-notice[role='status']")).toHaveCount(0);

    // See the comment in the previous test: wait for the Tab move to land
    // server-side before the finally block deletes the page.
    await waitForServerText(page, title, `Local copy:: [Goodlinks](/api/goodlinks/${stubLinkId(url)})`);
  } finally {
    if (title) await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});

test("the article route rejects a malformed id with 404 and serves no-store", async ({ page }) => {
  await login(page);
  expect((await page.request.get("/api/goodlinks/not-an-id")).status()).toBe(404);
  const ok = await page.request.get("/api/goodlinks/0123456789abcdef0123456789abcdef");
  expect(ok.status()).toBe(200);
  expect(ok.headers()["cache-control"]).toBe("private, no-store");
});
