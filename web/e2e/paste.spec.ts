// pkm-tu3a/pkm-fwa2: Shift-Cmd-V pastes an indented outline as real
// hierarchy (and a copied multi-block selection round-trips through it);
// plain Cmd-V always stays native, whatever the clipboard looks like.
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

/** Dispatch a synthetic paste. With `chord`, a Shift-Cmd-V keydown goes
 * first — that's what arms the outline split (pkm-fwa2); a real chord press
 * can't be used because Playwright's trusted keystroke would also trigger
 * the browser's own paste from the real (unknown) CI clipboard. Returns
 * whether the app intercepted the paste (called preventDefault). */
async function pasteText(page: Page, text: string, chord = false) {
  return await input(page).evaluate(
    (el: HTMLTextAreaElement, arg: { clip: string; chord: boolean }) => {
      if (arg.chord) {
        el.dispatchEvent(new KeyboardEvent("keydown", {
          key: "v", metaKey: true, shiftKey: true,
          bubbles: true, cancelable: true,
        }));
      }
      const dt = new DataTransfer();
      dt.setData("text/plain", arg.clip);
      return !el.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    }, { clip: text, chord });
}

test("plain paste of multi-line text is never intercepted (pkm-fwa2)", async ({ page }) => {
  await login(page);
  const title = `Paste Native ${Date.now()}`;
  await openFreshPage(page, title);

  await page.getByText("Click to start writing…").click();
  await input(page).fill("seed ");
  // No chord: the app must leave the event to the browser. A synthetic
  // (untrusted) paste never performs the native splice, so the assertion is
  // that nothing intercepted it and no blocks were created from it.
  const intercepted = await pasteText(page, "alpha\n\tbeta\ndelta");
  expect(intercepted).toBe(false);
  await waitForServerText(page, title, "seed");
  await input(page).press("Escape");
  await expect(page.locator(".block-text")).toHaveCount(1);
  await expect(page.locator(".block-text")).toHaveText(/seed/);
});

test("Shift-Cmd-V pastes an indented outline as nested blocks", async ({ page }) => {
  await login(page);
  const title = `Paste Target ${Date.now()}`;
  await openFreshPage(page, title);

  await page.getByText("Click to start writing…").click();
  await pasteText(page, "alpha\n\tbeta\n\t\tgamma\ndelta", true);
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
  await pasteText(page, "one\n\ttwo\n\t\tthree", true);
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
  await pasteText(page, copied!, true);
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
