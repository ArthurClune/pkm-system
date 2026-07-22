import { type Page } from "@playwright/test";
import { expect, test, trackResponses } from "./fixtures";
import { waitForServerText } from "./server-state";

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

// the End key does not move the caret in text fields on macOS — set it
const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

const afterPaint = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve())));

test("core editing loop: create, split, indent, persist, link, backlink", async ({ page }) => {
  await login(page);
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();
  const pageTitle = await today.locator("h1.page-title").innerText();

  // fresh DB: today is empty -> the start-writing affordance
  await today.getByText("Click to start writing…").click();
  await input(page).fill("first block");
  await input(page).press("Enter"); // split at end -> new empty sibling
  await input(page).fill("second block");
  await input(page).press("Tab");   // indent under "first block"
  // wait for the indent to settle: the textarea remounts under the new
  // parent and a post-paint effect re-focuses it and resets the caret —
  // pressing End before that effect races it (toBeVisible is not enough)
  await expect(page.locator(".block-children textarea.block-input")).toBeFocused();

  // link via [[ autocomplete: pick the New page row
  await caretToEnd(page);
  await input(page).pressSequentially(" ");
  await input(page).press("[");
  await afterPaint(page); // auto-pair caret restoration runs after paint
  await input(page).press("[");
  await afterPaint(page);
  await input(page).pressSequentially("E2E Target");
  await page.getByRole("option", { name: /New page: E2E Target/ }).click();
  await expect(input(page)).toHaveValue("second block [[E2E Target]]");
  await input(page).press("Escape"); // blur: flushes the draft op

  // wait for the server's own copy of the page to contain the final edit
  // before reloading — a ".ws-banner" check here is vacuous while connected
  // (see server-state.ts) and reload() can race the last batch's delivery
  await waitForServerText(page, pageTitle, "second block [[E2E Target]]");

  // persisted across a full reload, structure intact
  await page.reload();
  const day = page.locator(".journal-day").first();
  await expect(day.locator(".block-text", { hasText: "first block" })).toBeVisible();
  const child = day.locator(".block-children .block-text", { hasText: "second block" });
  await expect(child).toBeVisible();

  // the link navigates; the daily page shows up as a backlink
  await child.getByRole("link", { name: "E2E Target" }).click();
  await expect(page).toHaveURL(/\/page\/E2E%20Target/);
  await expect(page.locator(".backlinks")).toContainText("Linked references (1)");
  await expect(page.locator(".backlink-text")).toContainText("second block");
});

test("Tab and Shift-Tab move a multi-block selection one level (pkm-0ovd)", async ({ page }) => {
  const title = `MultiIndent${Date.now()}`;
  await login(page);
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText("Click to start writing…").click();

  await input(page).fill("indent parent");
  await input(page).press("Enter");
  await input(page).fill("indent first");
  await input(page).press("Enter");
  await input(page).fill("indent second");

  const topRows = page.locator(".block-tree > .block > .block-row");
  await expect(topRows).toHaveCount(3);
  const parentUid = await topRows.nth(0).getAttribute("data-uid");
  const firstUid = await topRows.nth(1).getAttribute("data-uid");
  const secondUid = await topRows.nth(2).getAttribute("data-uid");
  expect(parentUid).not.toBeNull();
  expect(firstUid).not.toBeNull();
  expect(secondUid).not.toBeNull();

  await input(page).press("Shift+ArrowUp");
  const tree = page.locator(".block-tree");
  await expect(tree).toBeFocused();
  await expect(page.locator(".block-row.selected")).toHaveCount(2);

  await page.keyboard.press("Tab");

  const childRows = page.locator(
    `.block-row[data-uid="${parentUid}"] + .block-children > .block > .block-row`,
  );
  await expect(childRows).toHaveCount(2);
  await expect(childRows.nth(0)).toHaveAttribute("data-uid", firstUid!);
  await expect(childRows.nth(1)).toHaveAttribute("data-uid", secondUid!);
  await expect(tree).toBeFocused();
  await expect(page.locator(".block-row.selected")).toHaveCount(2);

  await page.keyboard.press("Shift+Tab");

  await expect(topRows).toHaveCount(3);
  await expect(topRows.nth(0)).toHaveAttribute("data-uid", parentUid!);
  await expect(topRows.nth(1)).toHaveAttribute("data-uid", firstUid!);
  await expect(topRows.nth(2)).toHaveAttribute("data-uid", secondUid!);
  await expect(tree).toBeFocused();
  await expect(page.locator(".block-row.selected")).toHaveCount(2);
});

test("Shift-Cmd moves a selected run within and across a parent (pkm-8jt5)", async ({ page }) => {
  const title = `SelectedMove${Date.now()}`;
  await login(page);
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText("Click to start writing…").click();

  const rowWithText = (text: string) => page.locator(".block-row", {
    has: page.locator(".block-text", { hasText: text }),
  });

  await input(page).fill("left parent");
  await input(page).press("Enter");
  await input(page).fill("left existing");
  await input(page).press("Tab");
  await expect(page.locator(".block-children textarea.block-input")).toBeFocused();
  await input(page).press("Escape");
  await expect(rowWithText("left existing").locator(".block-text")).toBeVisible();

  await rowWithText("left existing").locator(".block-text").click();
  await caretToEnd(page);
  await input(page).press("Enter");
  await input(page).press("Shift+Tab");
  await expect(input(page)).toBeFocused();
  await input(page).fill("source parent");
  await input(page).press("Enter");
  await input(page).fill("source seed");
  await input(page).press("Tab");
  await expect(page.locator(".block-children textarea.block-input")).toBeFocused();
  await input(page).press("Escape");
  await expect(rowWithText("source seed").locator(".block-text")).toBeVisible();

  await rowWithText("source seed").locator(".block-text").click();
  await caretToEnd(page);
  await input(page).press("Enter");
  await input(page).fill("move first");
  await input(page).press("Enter");
  await input(page).fill("move second");
  await input(page).press("Escape");
  await expect(rowWithText("move second").locator(".block-text")).toBeVisible();

  await rowWithText("move second").locator(".block-text").click();
  await caretToEnd(page);
  await input(page).press("Enter");
  await input(page).press("Shift+Tab");
  await expect(input(page)).toBeFocused();
  await input(page).fill("right parent");
  await input(page).press("Escape");
  const leftUid = await rowWithText("left parent").getAttribute("data-uid");
  const sourceUid = await rowWithText("source parent").getAttribute("data-uid");
  const seedUid = await rowWithText("source seed").getAttribute("data-uid");
  const firstUid = await rowWithText("move first").getAttribute("data-uid");
  const secondUid = await rowWithText("move second").getAttribute("data-uid");
  expect(leftUid).not.toBeNull();
  expect(sourceUid).not.toBeNull();
  expect(seedUid).not.toBeNull();
  expect(firstUid).not.toBeNull();
  expect(secondUid).not.toBeNull();

  await rowWithText("move second").locator(".block-text").click();
  await caretToEnd(page);
  await input(page).press("Shift+ArrowUp");
  const tree = page.locator(".block-tree");
  const selectedRows = page.locator(".block-row.selected");
  await expect(tree).toBeFocused();
  await expect(selectedRows).toHaveCount(2);

  const directChildren = (uid: string) => page.locator(
    `.block-row[data-uid="${uid}"] + .block-children > .block > .block-row`,
  );

  await page.keyboard.press("Shift+Meta+ArrowUp");

  const sourceChildren = directChildren(sourceUid!);
  await expect(sourceChildren).toHaveCount(3);
  await expect(sourceChildren.nth(0)).toHaveAttribute("data-uid", firstUid!);
  await expect(sourceChildren.nth(1)).toHaveAttribute("data-uid", secondUid!);
  await expect(sourceChildren.nth(2)).toHaveAttribute("data-uid", seedUid!);
  await expect(tree).toBeFocused();
  await expect(selectedRows).toHaveCount(2);

  await page.keyboard.press("Shift+Meta+ArrowUp");

  await expect(sourceChildren).toHaveCount(1);
  await expect(sourceChildren.nth(0)).toHaveAttribute("data-uid", seedUid!);
  const leftChildren = directChildren(leftUid!);
  await expect(leftChildren).toHaveCount(3);
  await expect(leftChildren.nth(1)).toHaveAttribute("data-uid", firstUid!);
  await expect(leftChildren.nth(2)).toHaveAttribute("data-uid", secondUid!);
  await expect(tree).toBeFocused();
  await expect(selectedRows).toHaveCount(2);
  await expect(selectedRows.nth(0)).toHaveAttribute("data-uid", firstUid!);
  await expect(selectedRows.nth(1)).toHaveAttribute("data-uid", secondUid!);
});

test("can click back into a line after emptying it (pkm-mc07)", async ({ page }) => {
  await login(page);
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();

  // append a fresh sibling after whatever's already on today's page (this
  // must not assume an empty day: other tests in this file share the DB)
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }
  await input(page).fill("mc07-marker");
  await input(page).press("Escape"); // blur: renders as unfocused, non-empty

  const row = page.locator(".block-row", { has: page.locator(".block-text", { hasText: "mc07-marker" }) });
  const uid = await row.getAttribute("data-uid");
  const stableRow = page.locator(`.block-row[data-uid="${uid}"]`);

  // empty out the marker block, then blur it
  await row.locator(".block-text").click();
  await input(page).selectText();
  await page.keyboard.press("Backspace");
  await expect(input(page)).toHaveValue("");
  await input(page).press("Escape"); // blur: renders as unfocused, now-empty

  // clicking anywhere on that now-empty line's row must re-enter edit mode,
  // the same as it would for a line that was never written to
  await stableRow.click();
  await expect(input(page)).toBeFocused();
});

test("pausing mid [[ autocomplete does not create the partial page (pkm-xlah)", async ({ page }) => {
  // unique titles: the e2e DB is shared across specs and retries
  const stamp = Date.now();
  const scratch = `RefHold${stamp}`;
  const partial = `Xlah${stamp} Wo`;
  const full = `Xlah${stamp} Work`;
  await login(page);
  const createRes = await page.request.post("/api/pages", { data: { title: scratch } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(scratch)}`);
  await page.getByText("Click to start writing…").click();

  await input(page).pressSequentially("see ");
  await input(page).press("[");
  await afterPaint(page); // auto-pair caret restoration runs after paint
  await input(page).press("[");
  await afterPaint(page);
  await input(page).pressSequentially(`Xlah${stamp} Wo`);
  // pause well past the 500ms draft debounce with the ref still half-typed;
  // the held draft must not autosave (autosaving would create the page)
  await page.waitForTimeout(900);
  const midType = await page.request.get(`/api/page/${encodeURIComponent(partial)}`);
  expect(midType.status()).toBe(404);

  // finishing the ref creates only the completed title
  await input(page).pressSequentially("rk");
  await page.getByRole("option", { name: `New page: ${full}` }).click();
  await input(page).press("Escape"); // blur: flushes the draft op
  await waitForServerText(page, scratch, `see [[${full}]]`);
  expect((await page.request.get(`/api/page/${encodeURIComponent(partial)}`)).status())
    .toBe(404);
  expect((await page.request.get(`/api/page/${encodeURIComponent(full)}`)).ok())
    .toBeTruthy();
});

test("edits broadcast live to a second client", async ({ browser, badResponses }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  trackResponses(ctxA, badResponses);
  trackResponses(ctxB, badResponses);
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a);
  await login(b);

  const dayA = a.locator(".journal-day").first();
  await dayA.locator(".block-text").first().click();
  await caretToEnd(a);
  await input(a).press("Enter");
  await input(a).fill("sync-check-42");
  await input(a).press("Escape"); // flush

  // b sees it without reloading (websocket patch)
  await expect(b.locator(".journal-day").first())
    .toContainText("sync-check-42", { timeout: 10_000 });

  await ctxA.close();
  await ctxB.close();
});

test("Cmd-B bolds the selection and renders <strong> (pkm-kkpe)", async ({ page }) => {
  // unique page: the e2e DB is shared across specs/retries, and today's
  // journal must stay untouched (other specs assume its state)
  const title = `BoldKey${Date.now()}`;
  await login(page);
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText("Click to start writing…").click();

  await input(page).fill("make bold now");
  // select "bold" (5..9) and toggle
  await input(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 9));
  await input(page).press("Meta+b");
  await expect(input(page)).toHaveValue("make **bold** now");
  // applyKeyEdit restores the post-toggle selection inside a rAF (the
  // controlled-value re-render otherwise collapses it to the end, same as
  // the bracket auto-pair caret restoration above) — wait for it before the
  // next toggle reads the selection, or a fast enough press races it.
  await afterPaint(page);
  // toggle straight back off (selection stays on the inner text), then on again
  await input(page).press("Meta+b");
  await expect(input(page)).toHaveValue("make bold now");
  await afterPaint(page);
  await input(page).press("Meta+b");
  await input(page).press("Escape"); // blur: flushes the draft op

  await waitForServerText(page, title, "make **bold** now");
  await expect(page.locator(".block-text strong", { hasText: "bold" })).toBeVisible();
});
