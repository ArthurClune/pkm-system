// Embed rendering through the real tokenize -> render pipeline: a bare
// pasted URL (no markdown link syntax) must produce the embed (pkm-vuhl).
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

test("bare Bluesky URL renders as an embed iframe", async ({ page }) => {
  // hermetic: answer the handle->DID resolution locally (embed.bsky.app
  // only accepts DIDs in the embed path, pkm-es9o)
  const did = "did:plc:tq6gqh5aaohgi55y2yofylwj";
  await page.route("**/xrpc/com.atproto.identity.resolveHandle*", (route) =>
    route.fulfill({ json: { did } }));
  await login(page);
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }
  await input(page).fill("https://bsky.app/profile/cpaxton.bsky.social/post/3mp4jonwrfk2h");
  await input(page).press("Escape");
  const iframe = page.locator("iframe.bluesky-embed");
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute(
    "src",
    new RegExp(`embed\\.bsky\\.app/embed/${did}/app\\.bsky\\.feed\\.post/3mp4jonwrfk2h`),
  );
});
