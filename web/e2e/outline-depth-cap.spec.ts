// The outline depth cap: the editor refuses a command that would put a
// block past level 100 (the server would refuse the batch whole), leaves
// the block where it was, sends nothing, and says why in the page's notice
// slot. A command that stays within the cap still applies.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";
const NOTICE = "Blocks can't nest more than 100 levels deep.";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const created: string[] = [];
test.afterEach(async ({ page }) => {
  for (const title of created.splice(0)) {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});

// The uid of the row's parent block, or null at top level: a row sits in
// div.block, whose parent is the enclosing div.block-children.
const parentOf = (page: Page, uid: string) =>
  page.locator(`.block-row[data-uid="${uid}"]`).evaluate((row) => {
    const children = row.parentElement?.parentElement;
    if (!children?.classList.contains("block-children")) return null;
    const parentRow = children.parentElement
      ?.querySelector(":scope > .block-row") as HTMLElement | null;
    return parentRow?.dataset.uid ?? null;
  });

type Op = { op: string; uid: string; parent_uid?: string | null };

test("Tab at level 100 is refused with the notice and sends nothing",
     async ({ page }) => {
  await login(page);
  const stamp = Date.now().toString(36);
  const title = `Depth Cap ${stamp}`;
  const uid = (level: number) => `dc${stamp}l${level}`;
  const a100 = `dc${stamp}a100`;
  const b100 = `dc${stamp}b100`;
  created.push(title);
  expect((await page.request.post("/api/pages", { data: { title } })).ok())
    .toBeTruthy();
  // levels 1..99 as a chain, then two siblings at level 100 under level 99
  const ops: object[] = [];
  for (let level = 1; level <= 99; level++) {
    ops.push({ op: "create", uid: uid(level), page_title: title,
               parent_uid: level === 1 ? null : uid(level - 1), order_idx: 0,
               text: `level ${level} ${stamp}` });
  }
  ops.push({ op: "create", uid: a100, page_title: title, parent_uid: uid(99),
             order_idx: 0, text: `first at 100 ${stamp}` });
  ops.push({ op: "create", uid: b100, page_title: title, parent_uid: uid(99),
             order_idx: 1, text: `second at 100 ${stamp}` });
  expect((await page.request.post("/api/ops", { data: {
    client_id: "e2e-depth-cap", batch_id: `e2e-depth-cap-${stamp}`, ops,
  } })).ok()).toBeTruthy();

  // every op the SPA sends from here on (page.request bypasses page events)
  const sent: Op[] = [];
  const answered: Promise<unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/ops")) {
      sent.push(...(request.postDataJSON() as { ops: Op[] }).ops);
      answered.push(request.response());
    }
  });

  await page.goto(`/page/${encodeURIComponent(title)}`);
  // At the stylesheet's indent a level-100 row starts thousands of pixels
  // in, so its text is zero wide and cannot be clicked; narrow the indent.
  await page.addStyleTag({ content:
    ".block-children { margin-left: 2px !important; padding-left: 0 !important; }" });
  await page.getByText(`first at 100 ${stamp}`, { exact: true }).click();
  const input = page.locator("textarea.block-input");
  await expect(input).toHaveValue(`first at 100 ${stamp}`);
  await page.keyboard.press("ArrowDown");
  await expect(input).toHaveValue(`second at 100 ${stamp}`);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("status").filter({ hasText: NOTICE }))
    .toBeVisible();
  await expect(input).toBeFocused();
  expect(await parentOf(page, b100)).toBe(uid(99));

  // Level 99 still indents: out to 98 and back, its children landing at
  // 100 again. These ops queue behind anything the refused Tab could have
  // sent, so once they reach the server, `sent` holds every op since.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(input).toHaveValue(`level 99 ${stamp}`);
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => parentOf(page, uid(99))).toBe(uid(97));
  await page.keyboard.press("Tab");
  await expect.poll(() => parentOf(page, uid(99))).toBe(uid(98));
  expect(await parentOf(page, b100)).toBe(uid(99));

  await expect.poll(() => sent.filter((op) => op.op === "move")
    .map((op) => op.uid)).toEqual([uid(99), uid(99)]);
  expect(sent.some((op) => op.uid === b100)).toBe(false);
  await Promise.all(answered);
  const res = await page.request.get(`/api/block/${uid(98)}`);
  const body = await res.json() as { block: { children: { uid: string }[] } };
  expect(body.block.children.map((c) => c.uid)).toEqual([uid(99)]);
});
