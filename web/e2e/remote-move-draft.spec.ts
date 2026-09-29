import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

// Another device reparents the block being typed in, within the same page.
// The reparent remounts the textarea with no blur while the draft is still
// pending; the remounted textarea must resume the draft, with the caret where
// the user left it, instead of showing the tree's text. The draft is
// flush-held (caret mid #tag when typed), so no debounce races the remote op.

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

test("a remote reparent of the block being typed in keeps the typed text", async ({ page }) => {
  const stamp = Date.now();
  const title = `Remote Move Draft ${stamp}`;
  const tag = `SfpHeld${stamp}`;
  const u1 = `e2esfp1a${stamp}`.slice(0, 32);
  const u2 = `e2esfp1b${stamp}`.slice(0, 32);
  const remote = (id: string, ops: object[]) =>
    page.request.post("/api/ops", { data: {
      client_id: "e2e-remote-move", batch_id: `e2e-sfp1-${id}-${stamp}`, ops,
    } });
  await login(page);
  try {
    expect((await page.request.post("/api/pages", { data: { title } })).ok())
      .toBeTruthy();
    expect((await remote("create", [
      { op: "create", uid: u1, page_title: title, parent_uid: null,
        order_idx: 0, text: "first" },
      { op: "create", uid: u2, page_title: title, parent_uid: null,
        order_idx: 1, text: "second" },
    ])).ok()).toBeTruthy();

    await page.goto(`/page/${encodeURIComponent(title)}`);
    await page.getByText("first", { exact: true }).click();
    const input = page.locator("textarea.block-input");
    await expect(input).toBeFocused();
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.type(` #${tag}`); // caret mid-tag: the draft is held
    // A caret move with no edit: back to between "fi" and "rst".
    const typed = `first #${tag}`;
    for (let i = 0; i < typed.length - 2; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await expect.poll(() => input.evaluate(
      (el: HTMLTextAreaElement) => el.selectionStart)).toBe(2);

    expect((await remote("move", [
      { op: "move", uid: u1, parent_uid: u2, order_idx: 0, page_title: title },
    ])).ok()).toBeTruthy();

    // The move remounted the textarea under its new parent, and it took focus.
    const moved = page.locator(".block-children textarea.block-input");
    await expect(moved).toBeFocused();
    await expect(moved).toHaveValue(typed);
    expect(await moved.evaluate((el: HTMLTextAreaElement) =>
      [el.selectionStart, el.selectionEnd])).toEqual([2, 2]);

    await page.keyboard.type("x");
    await page.locator("h1.page-title").click(); // blur ships the draft
    await waitForServerText(page, title, `fixrst #${tag}`);
  } finally {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
    await page.request.delete(`/api/page/${encodeURIComponent(tag)}`);
  }
});
