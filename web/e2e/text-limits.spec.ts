// The block text limits: the editor refuses an edit that would store a text
// the server refuses (past 1,000,000 code points, or [[ nested past 32
// levels), says why in the page's notice slot, keeps the textarea's text
// and sends nothing. An edit up to the limit is saved.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PASSWORD = "e2e-pw";
const NESTING = "Links can't nest more than 32 levels deep.";
const LENGTH = "A block can't be longer than 1,000,000 characters.";

const nest = (n: number) => "[[a//".repeat(n) + "x" + "]]".repeat(n);

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const created: string[] = [];
test.afterEach(async ({ page }) => {
  for (const title of created.splice(0)) {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});

const input = (page: Page) => page.locator("textarea.block-input");

/** A fresh page holding one block, `seed`, focused with the caret at its
 * end. Returns every op text the SPA sends from then on. */
async function openSeeded(page: Page, name: string) {
  await login(page);
  const stamp = Date.now().toString(36);
  const title = `${name} ${stamp}`;
  const seed = `seed ${stamp}`;
  created.push(title);
  expect((await page.request.post("/api/pages", { data: { title } })).ok())
    .toBeTruthy();
  expect((await page.request.post("/api/ops", { data: {
    client_id: "e2e-text-limits", batch_id: `e2e-text-limits-${stamp}`,
    ops: [{ op: "create", uid: `tl${stamp}`, page_title: title,
            parent_uid: null, order_idx: 0, text: seed }],
  } })).ok()).toBeTruthy();

  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/ops")) {
      const body = request.postDataJSON() as
        { ops?: { text?: string }[] } | null;
      for (const op of body?.ops ?? []) {
        if (op.text !== undefined) sent.push(op.text);
      }
    }
  });

  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText(seed, { exact: true }).click();
  await expect(input(page)).toHaveValue(seed);
  await page.keyboard.press("End");
  return { title, seed, sent };
}

test("typing that nests links past 32 is refused with the notice",
     async ({ page }) => {
  const { title, seed, sent } = await openSeeded(page, "Nest Cap");

  await page.keyboard.insertText(nest(33));

  await expect(page.getByRole("status").filter({ hasText: NESTING }))
    .toBeVisible();
  await expect(input(page)).toHaveValue(seed);
  await expect(input(page)).toBeFocused();
  // the caret is back where the refused insertion began
  expect(await input(page).evaluate(
    (el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([seed.length, seed.length]);

  // An accepted edit after the blur queues behind anything the refused one
  // could have sent, so once it is saved `sent` holds every text since.
  await page.keyboard.press("Escape");
  await page.getByText(seed, { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("!");
  await page.keyboard.press("Escape");
  await waitForServerText(page, title, `${seed}!`);
  expect(sent).toEqual([`${seed}!`]);
});

test("typing links nested 32 deep is saved", async ({ page }) => {
  const { title, seed } = await openSeeded(page, "Nest Limit");

  await page.keyboard.insertText(nest(32));

  await expect(input(page)).toHaveValue(seed + nest(32));
  await page.keyboard.press("Escape");
  await waitForServerText(page, title, seed + nest(32));
  await expect(page.getByRole("status").filter({ hasText: NESTING }))
    .toHaveCount(0);
});

test("a paste past the length cap shows the notice and does not paste",
     async ({ page }) => {
  const { seed, sent } = await openSeeded(page, "Length Cap");

  // Synthetic, so no real clipboard is read; built in the page so a
  // megabyte does not cross the protocol.
  const intercepted = await input(page).evaluate(
    (el: HTMLTextAreaElement, length: number) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "y".repeat(length));
      return !el.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    }, 1_000_001);

  expect(intercepted).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: LENGTH }))
    .toBeVisible();
  await expect(input(page)).toHaveValue(seed);
  expect(sent).toEqual([]);
});
