// Undoing a file drop is final: redo is cleared and, once the undo has
// reached the server, the uploaded file is deleted unless a block still
// references it (a second drop of the same bytes).
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
  + "z8DQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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

async function setup(page: Page, label: string): Promise<{ rows: Locator; png: number[] }> {
  await login(page);
  title = `Undo Release ${label} ${Date.now()}`;
  expect((await page.request.post("/api/pages", { data: { title } })).ok()).toBe(true);
  const stamp = Date.now();
  const ops = ["first", "second"].map((text, i) => ({
    op: "create", uid: `undorel${stamp}${i}`, page_title: title,
    parent_uid: null, order_idx: i, text }));
  expect((await page.request.post("/api/ops", {
    data: { client_id: "e2e", batch_id: `undorel-${stamp}`, ops } })).ok()).toBe(true);
  await page.goto(`/page/${encodeURIComponent(title)}`);
  const rows = page.locator(".outline-drop-zone [data-uid]");
  await expect(rows).toHaveCount(2);
  // unique bytes: the asset store dedupes on content, so a prior copy would
  // make the upload a non-fresh hit
  return { rows, png: [...PNG, ...Buffer.from(`${stamp}`)] };
}

/** Drops the PNG in the gap below row `after` and returns its asset url once
 * the server holds the new block. */
async function dropPng(page: Page, rows: Locator, png: number[], after: number) {
  const row = await rows.nth(after).boundingBox();
  const zone = await page.locator(".outline-drop-zone").boundingBox();
  const at = { clientX: zone!.x + 5, clientY: row!.y + row!.height };
  const before = await rows.count();
  await page.evaluate(({ png, at }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(png)], "undo-release.png", { type: "image/png" }));
    (window as unknown as { __dt: DataTransfer }).__dt = dt;
    const zone = document.querySelector(".outline-drop-zone")!;
    for (const type of ["dragenter", "dragover"]) {
      zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
    }
  }, { png, at });
  await expect(page.locator(".drop-indicator")).toBeVisible();
  await page.evaluate((at) => {
    const dt = (window as unknown as { __dt: DataTransfer }).__dt;
    document.querySelector(".outline-drop-zone")!.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
  }, at);
  await expect(rows).toHaveCount(before + 1);
  let url = "";
  await expect.poll(async () => {
    const res = await page.request.get(`/api/page/${encodeURIComponent(title!)}`);
    const texts = ((await res.json()).blocks as { text: string }[]).map((b) => b.text);
    url = texts.map((t) => /^!\[undo-release\.png\]\((\/assets\/[^)]+)\)$/.exec(t)?.[1])
      .find(Boolean) ?? "";
    return url;
  }).not.toBe("");
  return url;
}

async function undo(page: Page) {
  await page.keyboard.press("Escape"); // no textarea focused, or it is textarea undo
  await page.keyboard.press("ControlOrMeta+z");
}

const status = (page: Page, url: string) =>
  page.request.get(url).then((r) => r.status());

test("undoing a drop deletes the file with no further edit", async ({ page }) => {
  const { rows, png } = await setup(page, "delete");
  const url = await dropPng(page, rows, png, 0);
  expect(await status(page, url)).toBe(200);
  await undo(page);
  await expect(rows).toHaveCount(2);
  await expect.poll(() => status(page, url)).toBe(404);
});

test("redo after undoing a drop does nothing", async ({ page }) => {
  const { rows, png } = await setup(page, "redo");
  const url = await dropPng(page, rows, png, 0);
  await undo(page);
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => status(page, url)).toBe(404);
  await expect(rows).toHaveCount(2);
});

test("undoing a second drop of the same bytes keeps the file", async ({ page }) => {
  const { rows, png } = await setup(page, "again");
  const url = await dropPng(page, rows, png, 0);
  const again = await dropPng(page, rows, png, 1);
  expect(again).toBe(url);
  await undo(page);
  await expect(rows).toHaveCount(3);
  // a delete would follow the undo's delivery; give it the chance
  await page.waitForTimeout(1500);
  expect(await status(page, url)).toBe(200);
});
