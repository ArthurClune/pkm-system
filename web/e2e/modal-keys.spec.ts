// Modal keyboard behaviour in a real browser: jsdom moves no focus on Tab and
// has no layout, so the trap, the scroll lock and the focus restore are only
// proven here. Each test works on its own page and leaves it in place for the
// fixture to delete.
import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";
import { rawTitleOf } from "../src/test-mint";

const insideDialog = (page: Page, role: "alertdialog" | "dialog") =>
  page.evaluate((r) =>
    document.activeElement?.closest(`[role="${r}"]`) !== null, role);

const bodyOverflow = (page: Page) =>
  page.evaluate(() => document.body.style.overflow);

test("the delete confirm keeps Tab inside, locks scrolling and gives both back on Escape",
     async ({ page, ownPage }) => {
  await page.getByRole("button", { name: "Page menu" }).click();
  const deleteItem = page.getByRole("menuitem", { name: "Delete page…" });
  await deleteItem.click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "Delete" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(confirm).toBeFocused();
  expect(await bodyOverflow(page)).toBe("hidden");

  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  expect(await insideDialog(page, "alertdialog")).toBe(true);
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  expect(await insideDialog(page, "alertdialog")).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  expect(await insideDialog(page, "alertdialog")).toBe(true);
  expect(await bodyOverflow(page)).toBe("hidden");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await bodyOverflow(page)).toBe("");
  // Escape stops at the dialog: the menu it opened from stays open, and
  // focus goes back to the item that opened it.
  await expect(deleteItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  const res = await page.request.get(
    `/api/page/${encodeURIComponent(ownPage.title)}`);
  expect(res.status()).toBe(200);
});

test("the blocked-delete dialog cycles Tab through its links and Close",
     async ({ page, ownPage }) => {
  // A query naming the page on a second page blocks the delete.
  const blockerTitle = rawTitleOf(`e2e modal blocker ${Date.now()}`);
  const created = await page.request.post("/api/pages",
                                          { data: { title: blockerTitle } });
  expect(created.ok()).toBeTruthy();
  try {
    const uid = `modalblk${Date.now()}`;
    const ops = await page.request.post("/api/ops", {
      data: {
        client_id: "e2e", batch_id: `modal-keys-${uid}`,
        ops: [{ op: "create", uid, page_title: blockerTitle,
                parent_uid: null, order_idx: 0,
                text: `{{query: [[${ownPage.title}]]}}` }],
      },
    });
    expect(ops.ok()).toBeTruthy();

    await page.getByRole("button", { name: "Page menu" }).click();
    await page.getByRole("menuitem", { name: "Delete page…" }).click();
    const dialog = page.getByRole("dialog", { name: /Can't delete/ });
    const close = dialog.getByRole("button", { name: "Close" });
    const link = dialog.getByRole("link", { name: blockerTitle });
    await expect(close).toBeFocused();
    expect(await bodyOverflow(page)).toBe("hidden");

    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    expect(await insideDialog(page, "dialog")).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await bodyOverflow(page)).toBe("");
    const res = await page.request.get(
      `/api/page/${encodeURIComponent(ownPage.title)}`);
    expect(res.status()).toBe(200);
  } finally {
    await page.request.delete(`/api/page/${encodeURIComponent(blockerTitle)}`);
  }
});
