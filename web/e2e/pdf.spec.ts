// The embedded PDF viewer end-to-end: upload a real 3-page PDF, link it in a
// block, and drive the react-pdf viewer -- pages rasterize to canvases, the
// indicator follows scroll, and the fullscreen overlay opens/closes (pkm-srek).
import { readFileSync } from "node:fs";
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const samplePdf = readFileSync(
  new URL("../../test-data/assets/sample.pdf", import.meta.url),
);

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

test("uploaded multi-page PDF renders, scrolls, and expands", async ({ page }) => {
  await login(page);

  // page.request shares the logged-in cookie jar
  const res = await page.request.post("/api/assets", {
    multipart: {
      file: { name: "sample.pdf", mimeType: "application/pdf", buffer: samplePdf },
    },
  });
  expect(res.ok()).toBe(true);
  const { url } = await res.json() as { url: string };

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
  await input(page).fill(`[three-page.pdf](${url})`);
  await input(page).press("Escape");

  // viewer chunk loads, document parses, page 1 rasterizes
  const frame = page.locator(".pdf-frame");
  await expect(frame).toBeVisible();
  await expect(page.locator(".pdf-page-slot canvas").first()).toBeVisible();
  await expect(page.locator(".pdf-page-indicator")).toHaveText("Page 1 of 3");

  // scrolling the frame mounts/rasterizes the rest and moves the indicator
  await frame.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator(".pdf-page-slot canvas")).toHaveCount(3);
  await expect(page.locator(".pdf-page-indicator")).toHaveText("Page 3 of 3");

  // expand to the fullscreen overlay; Escape collapses it
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  const overlay = page.locator(".pdf-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator("canvas").first()).toBeVisible();

  // modal a11y (pkm-bqrk): the dialog is aria-modal, focus moves to Close,
  // the page behind can't scroll, and Tab is trapped inside the overlay --
  // Close to the scroll frame (an explicit tab stop, so keyboard users can
  // scroll the PDF), then wrapping from the frame back to the Download link.
  await expect(overlay).toHaveAttribute("aria-modal", "true");
  await expect(overlay.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await page.keyboard.press("Tab");
  await expect(overlay.locator(".pdf-frame")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(overlay.getByRole("link", { name: "Download" })).toBeFocused();

  // clicking overlay content (not Close) must not collapse the overlay or
  // re-enter block-edit mode -- the whole viewer, including the portalled
  // overlay, is an interactive island (pkm-srek final review).
  await overlay.locator(".pdf-overlay-bar").click();
  await expect(overlay).toBeVisible();
  // the overlay mounts a fresh PdfPages with its own scroll position, so it
  // starts back at page 1 regardless of where the inline frame was scrolled;
  // scope to the overlay's own indicator since the inline footer's indicator
  // is still present (and unaffected) while the overlay is open.
  await expect(overlay.locator(".pdf-page-indicator")).toHaveText("Page 1 of 3");

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  // closing hands focus back to Expand and unlocks body scrolling (the
  // inline overflow style is removed, not just overridden)
  await expect(page.getByRole("button", { name: "Expand", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});

test("Roam-style {{[[pdf]]: …}} macro renders the viewer (pkm-ph1m)", async ({ page }) => {
  await login(page);

  const res = await page.request.post("/api/assets", {
    multipart: {
      file: { name: "sample.pdf", mimeType: "application/pdf", buffer: samplePdf },
    },
  });
  expect(res.ok()).toBe(true);
  const { url } = await res.json() as { url: string };

  // A dedicated page keeps this test independent of whatever blocks other
  // specs left on today's journal (whose first block may be a PDF embed --
  // an interactive island that clicks can't enter edit mode through).
  await page.getByLabel("Search").fill("PDF Macro");
  await page.locator(".search-result", { hasText: 'Create page "PDF Macro"' }).click();
  await expect(page.locator("h1.page-title")).toHaveText("PDF Macro");
  await page.getByText("Click to start writing…").click();
  await input(page).fill(`{{[[pdf]]: ${url}}}`);
  await input(page).press("Escape");

  await expect(page.locator(".pdf-frame")).toBeVisible();
  await expect(page.locator(".pdf-page-slot canvas").first()).toBeVisible();
  // the macro carries no link text: the label is the decoded filename
  await expect(page.locator(".pdf-download")).toHaveText("sample.pdf");
});
