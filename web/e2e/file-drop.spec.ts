// Dragging an image and a PDF in from outside the app: the page shows the
// block-drag drop line, and releasing uploads both as one new block each at
// the line. Synthetic events with a real DataTransfer stand in for Finder.
import { readFileSync } from "node:fs";
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PDF = readFileSync(new URL("../../test-data/assets/sample.pdf", import.meta.url));
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

test("dropping an image and a PDF between two blocks creates a block for each", async ({ page }) => {
  await login(page);
  title = `File Drop ${Date.now()}`;
  expect((await page.request.post("/api/pages", { data: { title } })).ok()).toBe(true);
  const stamp = Date.now();
  const ops = ["first", "second"].map((text, i) => ({
    op: "create", uid: `filedrop${stamp}${i}`, page_title: title,
    parent_uid: null, order_idx: i, text }));
  expect((await page.request.post("/api/ops", {
    data: { client_id: "e2e", batch_id: `filedrop-${stamp}`, ops } })).ok()).toBe(true);
  await page.goto(`/page/${encodeURIComponent(title)}`);
  const rows = page.locator(".outline-drop-zone [data-uid]");
  await expect(rows).toHaveCount(2);

  const gap = await rows.first().boundingBox();
  const zone = await page.locator(".outline-drop-zone").boundingBox();
  const at = { clientX: zone!.x + 5, clientY: gap!.y + gap!.height };

  // unique bytes: the asset store dedupes on content and answers with the
  // first filename it saw for them
  const png = [...PNG, ...Buffer.from(`${stamp}`)];
  await page.evaluate(({ png, pdf, at }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(png)], `drop-${at.clientY}.png`, { type: "image/png" }));
    dt.items.add(new File([new Uint8Array(pdf)], "drop.pdf", { type: "application/pdf" }));
    (window as unknown as { __dt: DataTransfer }).__dt = dt;
    const zone = document.querySelector(".outline-drop-zone")!;
    for (const type of ["dragenter", "dragover"]) {
      zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
    }
  }, { png, pdf: [...PDF], at });
  await expect(page.locator(".drop-indicator")).toBeVisible();

  await page.evaluate((at) => {
    const dt = (window as unknown as { __dt: DataTransfer }).__dt;
    document.querySelector(".outline-drop-zone")!.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
  }, at);

  await expect(rows).toHaveCount(4);
  await expect(page.locator(".drop-indicator")).toHaveCount(0);
  await expect(rows.nth(1).getByRole("img")).toBeVisible();
  // the UI is optimistic: wait for the server to hold all four
  const serverTexts = async () => {
    const res = await page.request.get(`/api/page/${encodeURIComponent(title!)}`);
    return ((await res.json()).blocks as { text: string }[]).map((b) => b.text);
  };
  await expect.poll(async () => (await serverTexts()).length).toBe(4);
  const texts = await serverTexts();
  expect(texts[0]).toBe("first");
  expect(texts[1]).toMatch(/^!\[drop-.*\.png\]\(\/assets\//);
  expect(texts[2]).toMatch(/^\[drop\.pdf\]\(\/assets\//);
  expect(texts[3]).toBe("second");
});
