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

const font = (el: Element) => {
  const s = getComputedStyle(el);
  return { family: s.fontFamily, size: s.fontSize };
};

let title: string | null = null;

test.afterEach(async ({ page }) => {
  if (title) await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  title = null;
});

test("a code fence typed with real keys edits in the font it renders in", async ({ page }) => {
  await login(page);
  title = `Code Edit Font ${Date.now()}`;
  expect((await page.request.post("/api/pages", { data: { title } })).ok()).toBe(true);
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText("Click to start writing…").click();

  const bodyFont = await input(page).evaluate(font);

  // Backticks auto-pair: the third one of the opener leaves a lone closer
  // after the caret, and two more after the last line make that the
  // closing fence. Shift+Enter is a newline inside the block.
  await page.keyboard.type("```");
  await expect(input(page)).toHaveValue("````");
  await expect(input(page)).not.toHaveClass(/\bcode-input\b/);
  for (const line of ["", "a    = 1", "bbbb = 2"]) {
    if (line) await page.keyboard.type(line);
    await page.keyboard.press("Shift+Enter");
  }
  await page.keyboard.type("``");
  await expect(input(page)).toHaveValue("```\na    = 1\nbbbb = 2\n```");

  await expect(input(page)).toHaveClass(/\bcode-input\b/);
  const editFont = await input(page).evaluate(font);
  expect(editFont).not.toEqual(bodyFont);

  await page.keyboard.press("Escape");
  const code = page.locator(".code-block code");
  await expect(code).toHaveText("a    = 1\nbbbb = 2");
  expect(await code.evaluate(font)).toEqual(editFont);

  // Prose ahead of the fence takes the block back to the body font.
  await code.click();
  await input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(0, 0));
  await page.keyboard.type("see ");
  await expect(input(page)).not.toHaveClass(/\bcode-input\b/);
  expect(await input(page).evaluate(font)).toEqual(bodyFont);
});
