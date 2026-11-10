// Embed rendering through the real tokenize -> render pipeline: a bare
// pasted URL (no markdown link syntax) must produce the embed.
import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";

const input = (page: Page) => page.locator("textarea.block-input");

test("bare Bluesky URL renders as an embed iframe", async ({ page, ownPage }) => {
  void ownPage;
  // hermetic: answer the handle->DID resolution locally (embed.bsky.app
  // only accepts DIDs in the embed path)
  const did = "did:plc:tq6gqh5aaohgi55y2yofylwj";
  await page.route("**/xrpc/com.atproto.identity.resolveHandle*", (route) =>
    route.fulfill({ json: { did } }));
  await page.getByText("Click to start writing…").click();
  await input(page).fill("https://bsky.app/profile/cpaxton.bsky.social/post/3mp4jonwrfk2h");
  await input(page).press("Escape");
  const iframe = page.locator("iframe.bluesky-embed");
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute(
    "src",
    new RegExp(`embed\\.bsky\\.app/embed/${did}/app\\.bsky\\.feed\\.post/3mp4jonwrfk2h`),
  );
});
