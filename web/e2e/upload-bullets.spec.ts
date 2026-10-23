// Each upload into a block lands on its own sibling bullet after it; an empty
// block takes the first upload.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
  + "z8DQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

type BlockNode = { text: string; children: BlockNode[] };

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

let title: string | null = null;
test.afterEach(async ({ page }) => {
  if (title) await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  title = null;
});

/** Creates a fresh page with the seed blocks (siblings) and opens it. */
async function setup(page: Page, label: string, seeds: string[]) {
  await login(page);
  title = `Upload Bullets ${label} ${Date.now()}`;
  expect((await page.request.post("/api/pages", { data: { title } })).ok()).toBe(true);
  const stamp = Date.now();
  const ops = seeds.map((text, i) => ({
    op: "create", uid: `upbul${stamp}-${i}`, page_title: title,
    parent_uid: null, order_idx: i, text }));
  expect((await page.request.post("/api/ops", {
    data: { client_id: "e2e", batch_id: `upbul-${stamp}`, ops } })).ok()).toBe(true);
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator(".outline-drop-zone [data-uid]")).toHaveCount(seeds.length);
  // unique bytes: the asset store dedupes on content
  return [...PNG, ...Buffer.from(`${stamp}`)];
}

async function serverBlocks(page: Page): Promise<BlockNode[]> {
  const res = await page.request.get(`/api/page/${encodeURIComponent(title!)}`);
  if (!res.ok()) return [];
  return ((await res.json()) as { blocks: BlockNode[] }).blocks;
}

test("/upload with two images adds two sibling bullets", async ({ page }) => {
  const png = await setup(page, "slash", ["Photos", "After"]);
  await page.locator(".block-text", { hasText: "Photos" }).click();
  const input = page.locator("textarea.block-input");
  await input.press("Home");
  await input.pressSequentially("/upload");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("option", { name: "upload file…" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles([
    { name: "a.png", mimeType: "image/png", buffer: Buffer.from(png) },
    { name: "b.png", mimeType: "image/png",
      buffer: Buffer.from([...png, ...Buffer.from("b")]) },
  ]);
  await expect.poll(async () => (await serverBlocks(page)).map((b) => b.text),
    { timeout: 20_000 }).toEqual([
    "Photos", expect.stringMatching(/^!\[a\.png\]/),
    expect.stringMatching(/^!\[b\.png\]/), "After"]);
  const blocks = await serverBlocks(page);
  expect(blocks.every((b) => b.children.length === 0)).toBe(true);
});

test("pasting an image into an empty block fills it", async ({ page }) => {
  const png = await setup(page, "paste", [""]);
  await page.locator(".outline-drop-zone [data-uid]").first().click();
  const input = page.locator("textarea.block-input");
  await expect(input).toBeFocused();
  await input.evaluate((el: HTMLTextAreaElement, bytes: number[]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "p.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await expect.poll(async () => (await serverBlocks(page)).map((b) => b.text),
    { timeout: 20_000 }).toEqual([expect.stringMatching(/^!\[p\.png\]/)]);
});
