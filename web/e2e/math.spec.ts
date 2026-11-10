import { type Page } from "@playwright/test";
import { expect, test } from "./ownPage";

const input = (page: Page) => page.locator("textarea.block-input");

const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

test("renders $$...$$ as KaTeX, inline and display", async ({ page, ownPage }) => {
  void ownPage;
  await page.getByText("Click to start writing…").click();

  await input(page).fill("inline math $$x^2 + y^2 = z^2$$ mid-sentence");
  await input(page).press("Enter");
  await input(page).fill("$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$");
  await input(page).press("Escape"); // blur: leaves edit mode, renders math

  // inline: KaTeX output flows inside the block text, not display mode
  const inlineBlock = page.locator(".block-text", { hasText: "mid-sentence" });
  await expect(inlineBlock.locator(".math-inline .katex")).toBeVisible();
  await expect(inlineBlock.locator(".katex-display")).toHaveCount(0);

  // display: the whole-block expression renders in KaTeX display mode
  const displayBlock = page.locator(".block-text .math-display");
  await expect(displayBlock.locator(".katex-display")).toBeVisible();

  // error fallback: invalid TeX shows the raw source, tinted, not a crash
  // (Escape above blurred and unmounted the textarea -- re-enter edit mode
  // on the last block before continuing, same pattern as the startWriting
  // click above)
  await displayBlock.click();
  await caretToEnd(page);
  await input(page).press("Enter");
  await input(page).fill("$$\\frac{$$ broken");
  await input(page).press("Escape");
  const errorBlock = page.locator(".block-text", { hasText: "broken" });
  await expect(errorBlock.locator(".math-error")).toBeVisible();
  await expect(errorBlock.locator(".math-error")).toHaveText("$$\\frac{$$");
});
