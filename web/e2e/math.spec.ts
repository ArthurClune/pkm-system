import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

test("renders $$...$$ as KaTeX, inline and display (pkm-lr96)", async ({ page }) => {
  await login(page);
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();

  // append after whatever is already on today's page (shared E2E DB)
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }

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
  // branch above)
  await displayBlock.click();
  await caretToEnd(page);
  await input(page).press("Enter");
  await input(page).fill("$$\\frac{$$ broken");
  await input(page).press("Escape");
  const errorBlock = page.locator(".block-text", { hasText: "broken" });
  await expect(errorBlock.locator(".math-error")).toBeVisible();
  await expect(errorBlock.locator(".math-error")).toHaveText("$$\\frac{$$");
});
