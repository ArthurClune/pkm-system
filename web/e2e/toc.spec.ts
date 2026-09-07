// The /toc slash command (pkm-mzks): the block stores only "{{toc}}", and
// an unfocused toc block renders the page's headings, re-derived from the
// live block tree — so editing a heading changes the list with no refresh.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  // wait until the websocket is up (editing unpauses)
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");
const tocLinks = (page: Page) => page.locator("nav.toc a.toc-link");

test("a {{toc}} block lists the page's headings and follows their edits",
     async ({ page }) => {
  await login(page);

  // A fresh, uniquely-named page, never today's journal: the e2e DB is
  // shared and other specs assume the journal starts empty
  // (backlink-filter.spec.ts idiom).
  const src = `Toc Page ${Date.now()}`;
  const createRes = await page.request.post("/api/pages", { data: { title: src } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(src)}`);
  await page.getByText("Click to start writing…").click();

  // Make the first block a heading, then give it its text. /h1 has no text
  // transform of its own: picking it strips the trigger and dispatches a
  // SetHeadingOp (BlockInput.tsx), leaving the block focused and empty.
  await input(page).fill("/h1");
  // Popup rows pick on mousedown; click() delivers it (slash-dates idiom).
  await page.getByRole("option", { name: "heading 1" }).click();
  await input(page).fill("Intro");
  await expect(input(page)).toHaveClass(/heading-1/);

  // A second block, holding the macro.
  await input(page).press("Enter");
  await input(page).fill("/toc");
  await page.getByRole("option", { name: "table of contents" }).click();
  await expect(input(page)).toHaveValue("{{toc}}");

  // Escape blurs the block, which is what swaps the raw macro for the list.
  await input(page).press("Escape");
  await expect(tocLinks(page)).toHaveText(["Intro"]);
  await expect(page.locator("nav.toc")).toHaveAttribute(
    "aria-label", "Table of contents");

  // Editing the heading re-derives the list: no reload, no stored copy.
  await page.locator("h1.block-text").click();
  await input(page).fill("Introduction");
  await input(page).press("Escape");
  await expect(tocLinks(page)).toHaveText(["Introduction"]);

  // A second heading joins the list in document order.
  await page.locator("h1.block-text").click();
  await input(page).press("Enter");
  await input(page).fill("/h2");
  await page.getByRole("option", { name: "heading 2" }).click();
  await input(page).fill("Details");
  await input(page).press("Escape");
  await expect(tocLinks(page)).toHaveText(["Introduction", "Details"]);
});
