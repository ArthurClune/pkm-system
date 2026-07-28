// pkm-tu3a: pasting an indented outline creates real hierarchy, and a
// copied multi-block selection round-trips through paste.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

/** Create a fresh page over the API and open it (never touches the shared
 * journal). */
async function openFreshPage(page: Page, title: string) {
  const res = await page.request.post("/api/pages", {
    data: { title },
  });
  expect(res.ok()).toBe(true);
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator("h1.page-title")).toHaveText(title);
}

async function pasteText(page: Page, text: string) {
  await input(page).evaluate((el: HTMLTextAreaElement, clip: string) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", clip);
    el.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
  }, text);
}

test("pasting an indented outline creates nested blocks", async ({ page }) => {
  await login(page);
  const title = `Paste Target ${Date.now()}`;
  await openFreshPage(page, title);

  await page.getByText("Click to start writing…").click();
  await pasteText(page, "alpha\n\tbeta\n\t\tgamma\ndelta");
  // focus lands on the last-created block ("delta"); it renders as a live
  // textarea rather than a ".block-text" span until blurred, so blur it
  // before counting rendered text nodes.
  await input(page).press("Escape");

  // hierarchy renders: beta under alpha, gamma under beta, delta top-level
  const blocks = page.locator(".block-text");
  await expect(blocks).toHaveCount(4);
  await expect(page.locator(".block-children .block-text",
                            { hasText: "beta" })).toBeVisible();
  await expect(page.locator(".block-children .block-children .block-text",
                            { hasText: "gamma" })).toBeVisible();
  await waitForServerText(page, title, "gamma");

  // server structure: beta nests under alpha, gamma nests under beta, and
  // delta is a ROOT sibling, not nested under anything
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  const body = await res.json() as {
    blocks: { text: string;
              children: { text: string;
                          children: { text: string }[] }[] }[];
  };
  expect(body.blocks.map((b) => b.text)).toEqual(["alpha", "delta"]);
  expect(body.blocks[0].children[0].text).toBe("beta");
  expect(body.blocks[0].children[0].children[0].text).toBe("gamma");
});

test("copy of a multi-block selection round-trips hierarchy", async ({ page }) => {
  await login(page);
  const src = `Paste Src ${Date.now()}`;
  await openFreshPage(page, src);

  await page.getByText("Click to start writing…").click();
  await pasteText(page, "one\n\ttwo\n\t\tthree");
  await waitForServerText(page, src, "three");

  // capture the clipboard: writeText is patched to window.__copied (pattern
  // from pkm-y6af)
  await page.evaluate(() => {
    (window as unknown as { __copied?: string }).__copied = undefined;
    navigator.clipboard.writeText = (t: string) => {
      (window as unknown as { __copied?: string }).__copied = t;
      return Promise.resolve();
    };
  });

  // Select all three blocks using the proven multi-select recipe from the
  // pkm-0ovd Tab test (edit.spec.ts): extend the selection upward twice from
  // the deepest block. Focus already rests on "three" — planOutlinePaste's
  // focus target is the last-created descendant — so no click is needed
  // (and "three" isn't a ".block-text" span yet anyway: the focused block
  // renders as a live textarea until blurred). The first Shift+ArrowUp fires
  // while the textarea is focused, is treated as an edge-of-block
  // collapsed-caret press, and already selects two rows (current + one
  // above) while moving focus to .block-tree; the second Shift+ArrowUp is
  // tree-owned (the textarea unmounts once a selection exists) and extends
  // to all three.
  await expect(input(page)).toHaveValue("three");
  await input(page).press("Shift+ArrowUp");
  const tree = page.locator(".block-tree");
  await expect(tree).toBeFocused();
  await expect(page.locator(".block-row.selected")).toHaveCount(2);
  await page.keyboard.press("Shift+ArrowUp");
  await expect(page.locator(".block-row.selected")).toHaveCount(3);

  // ControlOrMeta+c is Playwright's cross-platform alias for the chord the
  // tree's keydown handler accepts ((e.metaKey || e.ctrlKey) && key "c").
  await page.keyboard.press("ControlOrMeta+c");
  const copied = await page.evaluate(() =>
    (window as unknown as { __copied?: string }).__copied);
  expect(copied).toBe("one\n\ttwo\n\t\tthree");

  // paste the captured text into a fresh page and verify the structure
  const dst = `Paste Dst ${Date.now()}`;
  await openFreshPage(page, dst);
  await page.getByText("Click to start writing…").click();
  await pasteText(page, copied!);
  await waitForServerText(page, dst, "three");
  const res = await page.request.get(`/api/page/${encodeURIComponent(dst)}`);
  const body = await res.json() as {
    blocks: { text: string;
              children: { text: string;
                          children: { text: string }[] }[] }[];
  };
  expect(body.blocks).toHaveLength(1);
  expect(body.blocks[0].text).toBe("one");
  expect(body.blocks[0].children[0].text).toBe("two");
  expect(body.blocks[0].children[0].children[0].text).toBe("three");
});
