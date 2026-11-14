// In-app find (Cmd-F) is only wired in the installed app, so standalone is
// forced by wrapping matchMedia before the page loads.
import { type Page } from "@playwright/test";
import type { RawTitle } from "../src/api/brands";
import { expect, test } from "./ownPage";

async function forceStandalone(page: Page) {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const list = real(query);
      if (query !== "(display-mode: standalone)") return list;
      return new Proxy(list, {
        get: (target, prop) => {
          if (prop === "matches") return true;
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    };
  });
}

async function seed(page: Page, title: RawTitle, texts: string[]) {
  const stamp = Date.now().toString(36);
  const res = await page.request.post("/api/ops", { data: {
    client_id: "e2e-find", batch_id: `e2e-find-${stamp}-${Math.random()}`,
    ops: texts.map((text, i) => ({
      op: "create", uid: `fnd${stamp}${i}`, page_title: title,
      parent_uid: null, order_idx: i, text })) } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".block-text", { hasText: texts[0] }))
    .toBeVisible();
}

const highlightCount = (page: Page) =>
  page.evaluate(() => CSS.highlights.get("pkm-find")?.size);

test("Cmd-F finds and steps through matches", async ({ page, ownPage }) => {
  await forceStandalone(page);
  await seed(page, ownPage.title, ["alpha one", "beta", "alpha two"]);
  await page.keyboard.press("Meta+f");
  const bar = page.getByRole("search");
  await page.getByRole("textbox", { name: "Find on page" }).fill("alpha");
  await expect(bar).toContainText("1 of 2");
  await expect.poll(() => highlightCount(page)).toBe(2);
  await page.keyboard.press("Meta+g");
  await expect(bar).toContainText("2 of 2");
  await page.keyboard.press("Meta+Shift+g");
  await expect(bar).toContainText("1 of 2");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(bar).toContainText("2 of 2");
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
});

test("searches a block that was being edited and Escape re-enters it",
     async ({ page, ownPage }) => {
  await forceStandalone(page);
  await seed(page, ownPage.title, ["alpha one", "beta"]);
  await page.locator(".block-text", { hasText: "alpha one" }).click();
  await expect(page.locator("textarea.block-input")).toBeFocused();
  await page.keyboard.press("Meta+f");
  await page.getByRole("textbox", { name: "Find on page" }).fill("one");
  await expect(page.getByRole("search")).toContainText("1 of 1");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("search")).toHaveCount(0);
  const input = page.locator("textarea.block-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("alpha one");
  // A draft still being typed is saved when find takes focus, and found.
  await page.keyboard.type(" xyz");
  await page.keyboard.press("Meta+f");
  await page.getByRole("textbox", { name: "Find on page" }).fill("xyz");
  await expect(page.getByRole("search")).toContainText("1 of 1");
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("alpha one xyz");
});

test("Escape closes the bar after a click into the page",
     async ({ page, ownPage }) => {
  await forceStandalone(page);
  await seed(page, ownPage.title, ["alpha one", "beta"]);
  await page.keyboard.press("Meta+f");
  await page.getByRole("textbox", { name: "Find on page" }).fill("alpha");
  await expect(page.getByRole("search")).toContainText("1 of 1");
  await page.locator(".block-text", { hasText: "beta" }).click();
  const input = page.locator("textarea.block-input");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("search")).toHaveCount(0);
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});

test("leaves Cmd-F to the browser outside the installed app",
     async ({ page, ownPage }) => {
  await seed(page, ownPage.title, ["alpha one"]);
  // Registered after load so it runs after FindBar's capture-phase handler.
  await page.evaluate(() => {
    const w = window as unknown as { findPrevented: boolean[] };
    w.findPrevented = [];
    window.addEventListener("keydown", (e) => {
      if (e.metaKey && e.key === "f") w.findPrevented.push(e.defaultPrevented);
    });
  });
  await page.keyboard.press("Meta+f");
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { findPrevented: boolean[] }).findPrevented))
    .toEqual([false]);
  await expect(page.getByRole("search")).toHaveCount(0);
});
