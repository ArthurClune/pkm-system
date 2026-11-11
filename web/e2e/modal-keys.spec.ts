// Modal keyboard behaviour in a real browser: jsdom moves no focus on Tab and
// has no layout, so the trap, the scroll lock and the focus restore are only
// proven here. Each test works on its own page and leaves it in place for the
// fixture to delete.
import { readFileSync } from "node:fs";
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./ownPage";
import { waitForServerText } from "./server-state";
import { rawTitleOf } from "../src/test-mint";

const input = (page: Page) => page.locator("textarea.block-input");

const insideDialog = (page: Page, role: "alertdialog" | "dialog") =>
  page.evaluate((r) =>
    document.activeElement?.closest(`[role="${r}"]`) !== null, role);

const bodyOverflow = (page: Page) =>
  page.evaluate(() => document.body.style.overflow);

const bodyHasFocus = (page: Page) =>
  page.evaluate(() => document.activeElement === document.body);

/** Tab and Shift+Tab, twice each, leave focus on `pinned`. */
async function expectTabPinned(page: Page, pinned: Locator) {
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(pinned).toBeFocused();
  }
}

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

test("confirming the delete with Enter closes the menu, so no second confirm opens",
     async ({ page, ownPage }) => {
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitem", { name: "Delete page…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.waitForURL("**/");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const res = await page.request.get(
    `/api/page/${encodeURIComponent(ownPage.title)}`);
  expect(res.status()).toBe(404);
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

// The same one-pixel PNG image-expansion.spec.ts uploads, so the asset store
// gains nothing new.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",  // noqa: E501
  "base64",
);

test("the image overlay pins Tab on Close and gives focus back to its trigger",
     async ({ page, ownPage }) => {
  const response = await page.request.post("/api/assets", {
    multipart: { file: { name: "pic.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(response.ok()).toBe(true);
  const { url } = await response.json() as { url: string };
  await page.getByText("Click to start writing…").click();
  await input(page).fill(`![pic](${url})`);
  await input(page).press("Escape");
  await waitForServerText(page, ownPage.title, `![pic](${url})`);

  const trigger = page.getByRole("button", { name: "Expand image: pic" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Expanded image: pic" });
  const close = dialog.getByRole("button", { name: "Close" });
  await expect(close).toBeFocused();
  expect(await bodyOverflow(page)).toBe("hidden");
  await expectTabPinned(page, close);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await bodyOverflow(page)).toBe("");
});

// server/tests/fake_goodlinks_server.py's seeded article.
const ARTICLE_HREF = "/api/goodlinks/0123456789abcdef0123456789abcdef";

test("the GoodLinks reader pins Tab on Close and gives focus back to its link",
     async ({ page, ownPage }) => {
  const text = `Local copy:: [Goodlinks](${ARTICLE_HREF})`;
  await page.getByText("Click to start writing…").click();
  await input(page).fill(text);
  await input(page).press("Escape");
  await waitForServerText(page, ownPage.title, text);

  const open = page.getByRole("button", { name: "Goodlinks", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "E2E Article" });
  await expect(dialog.locator("iframe.goodlinks-reader-frame")).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close" });
  await expect(close).toBeFocused();
  expect(await bodyOverflow(page)).toBe("hidden");
  await expectTabPinned(page, close);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(await bodyOverflow(page)).toBe("");
});

test("the local-file picker pins Tab on its search box and closes on Escape",
     async ({ page, ownPage }) => {
  void ownPage;
  await page.getByText("Click to start writing…").click();
  await input(page).fill("/link-local-file");
  await page.getByRole("option", { name: "link to local file…" }).click();
  const dialog = page.getByRole("dialog", { name: "Link a local file" });
  const search = dialog.getByRole("combobox", { name: "Search local files" });
  await expect(search).toBeFocused();
  await expect(dialog.getByRole("option", { name: "Papers" })).toBeVisible();
  expect(await bodyOverflow(page)).toBe("hidden");
  await expectTabPinned(page, search);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await bodyOverflow(page)).toBe("");
  // The command gave the block up before the picker opened, so there is
  // nothing to go back to.
  expect(await bodyHasFocus(page)).toBe(true);
  await expect(input(page)).toHaveCount(0);
});

test("the PDF overlay cycles Tab both ways and gives focus back to Expand",
     async ({ page, ownPage }) => {
  const text = "Local copy:: [sample.pdf](/api/local/Papers/sample.pdf)";
  await page.getByText("Click to start writing…").click();
  await input(page).fill(text);
  await input(page).press("Escape");
  await waitForServerText(page, ownPage.title, text);
  await page.getByRole("button", { name: "Open", exact: true }).click();

  const expand = page.getByRole("button", { name: "Expand", exact: true });
  await expand.click();
  const overlay = page.getByRole("dialog", { name: "sample.pdf" });
  await expect(overlay.locator("canvas").first()).toBeVisible();
  const close = overlay.getByRole("button", { name: "Close" });
  const download = overlay.getByRole("link", { name: "Download" });
  const frame = overlay.locator(".pdf-frame");
  await expect(close).toBeFocused();
  expect(await bodyOverflow(page)).toBe("hidden");

  await page.keyboard.press("Shift+Tab");
  await expect(download).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(frame).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(download).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(expand).toBeFocused();
  expect(await bodyOverflow(page)).toBe("");
});

// The upload pdf.spec.ts makes, so the asset store gains nothing new.
const samplePdf = readFileSync(
  new URL("../../test-data/assets/sample.pdf", import.meta.url),
);

test("the /files PDF overlay traps Tab and gives focus back to its card",
     async ({ page, ownPage }) => {
  void ownPage;
  const res = await page.request.post("/api/assets", {
    multipart: {
      file: { name: "sample.pdf", mimeType: "application/pdf",
              buffer: samplePdf },
    },
  });
  expect(res.ok()).toBe(true);

  await page.goto("/files");
  await page.getByLabel("Search names & descriptions").fill("sample.pdf");
  const thumb = page.getByRole("button", { name: "Open PDF: sample.pdf" })
    .first();
  await thumb.click();
  const overlay = page.getByRole("dialog", { name: "sample.pdf" });
  await expect(overlay.locator("canvas").first()).toBeVisible();
  const close = overlay.getByRole("button", { name: "Close" });
  await expect(close).toBeFocused();
  expect(await bodyOverflow(page)).toBe("hidden");

  await page.keyboard.press("Tab");
  await expect(overlay.locator(".pdf-frame")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(overlay.getByRole("link", { name: "Download" }))
    .toBeFocused();

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(thumb).toBeFocused();
  expect(await bodyOverflow(page)).toBe("");
});
