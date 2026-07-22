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
const rows = (page: Page) => page.locator(".block-row");
const focusedUid = (page: Page) => page.locator(".block-row.focused").getAttribute("data-uid");

/** Long, space-separated, newline-free text: at the narrow viewport below it
 * soft-wraps onto many display lines, which is exactly the case the old
 * logical-newline-only heuristic couldn't see (pkm-2867). */
const WRAPPED_TEXT = Array.from({ length: 12 },
  () => "lorem ipsum dolor sit amet consectetur adipiscing elit").join(" ");

async function createTopLevelBlocks(page: Page, texts: string[]) {
  await page.getByText("Click to start writing…").click();
  for (let i = 0; i < texts.length; i++) {
    await input(page).fill(texts[i]);
    if (i < texts.length - 1) await input(page).press("Enter");
  }
  await input(page).press("Escape"); // blur: flushes the draft op
}

async function setCaret(page: Page, pos: number) {
  await input(page).evaluate(
    (el: HTMLTextAreaElement, p: number) => el.setSelectionRange(p, p), pos);
}

test.describe("wrapped-block boundary arrows (pkm-2867)", () => {
  test("plain ArrowUp/Down move within a wrapped block before jumping blocks", async ({ page }) => {
    // Narrow enough to force soft-wrap, but above the 600px phone breakpoint
    // (below it the composer replaces normal block editing entirely).
    await page.setViewportSize({ width: 650, height: 800 });
    const title = `WrapArrow${Date.now()}`;
    await login(page);
    const createRes = await page.request.post("/api/pages", { data: { title } });
    expect(createRes.ok()).toBeTruthy();
    await page.goto(`/page/${encodeURIComponent(title)}`);

    await createTopLevelBlocks(page, ["block above", WRAPPED_TEXT, "block below"]);
    await expect(rows(page)).toHaveCount(3);
    const aboveUid = await rows(page).nth(0).getAttribute("data-uid");
    const wrappedUid = await rows(page).nth(1).getAttribute("data-uid");
    const belowUid = await rows(page).nth(2).getAttribute("data-uid");

    // --- ArrowUp from a middle display line stays in the block ---
    await rows(page).nth(1).locator(".block-text").click();
    await expect(input(page)).toBeFocused();
    const mid = Math.floor(WRAPPED_TEXT.length / 2);
    await setCaret(page, mid);

    await page.keyboard.press("ArrowUp");
    expect(await focusedUid(page)).toBe(wrappedUid); // did not jump yet
    const afterOnePress = await input(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart);
    expect(afterOnePress).toBeLessThan(mid); // caret moved up a visual line

    // Keep pressing until it reaches the first display line and jumps to the
    // block above. Generous budget: WRAPPED_TEXT wraps onto well over a
    // dozen lines at this viewport.
    let jumpedUp = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("ArrowUp");
      if (await focusedUid(page) === aboveUid) { jumpedUp = true; break; }
    }
    expect(jumpedUp).toBe(true);

    // --- ArrowDown from a middle display line stays in the block ---
    await rows(page).nth(1).locator(".block-text").click();
    await setCaret(page, mid);

    await page.keyboard.press("ArrowDown");
    expect(await focusedUid(page)).toBe(wrappedUid); // did not jump yet
    const afterOneDown = await input(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart);
    expect(afterOneDown).toBeGreaterThan(mid); // caret moved down a visual line

    let jumpedDown = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("ArrowDown");
      if (await focusedUid(page) === belowUid) { jumpedDown = true; break; }
    }
    expect(jumpedDown).toBe(true);
  });

  test("plain ArrowUp still jumps immediately in a short, non-wrapping block", async ({ page }) => {
    const title = `WrapArrowShort${Date.now()}`;
    await login(page);
    const createRes = await page.request.post("/api/pages", { data: { title } });
    expect(createRes.ok()).toBeTruthy();
    await page.goto(`/page/${encodeURIComponent(title)}`);

    await createTopLevelBlocks(page, ["top block", "short block", "bottom block"]);
    const topUid = await rows(page).nth(0).getAttribute("data-uid");

    await rows(page).nth(1).locator(".block-text").click(); // caret lands at text end
    await expect(input(page)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    expect(await focusedUid(page)).toBe(topUid);
  });
});
