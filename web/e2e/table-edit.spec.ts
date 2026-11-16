import type { Page } from "@playwright/test";
import type { RawTitle } from "../src/api/brands";
import type { PagePayload } from "../src/api/payloads";
import { uidOf } from "../src/test-mint";
import { expect, test } from "./ownPage";
import { serverJson } from "./wireJson";

type ServerBlock = PagePayload["blocks"][number];

/** The table's rows as the server holds them: each row's cell chain. */
async function serverRows(page: Page, title: RawTitle): Promise<string[][]> {
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  expect(res.ok()).toBeTruthy();
  const [table] = (await serverJson<PagePayload>(res)).blocks;
  const chain = (b: ServerBlock | undefined): string[] =>
    b ? [b.text, ...chain(b.children[0])] : [];
  return (table?.children ?? []).map((row) => chain(row));
}

/** Every block on `title`, at any depth, by uid and parent. */
async function serverTree(page: Page, title: RawTitle): Promise<string[]> {
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  expect(res.ok()).toBeTruthy();
  const walk = (b: ServerBlock, parent: string): string[] =>
    [`${parent}>${b.uid}`, ...b.children.flatMap((c) => walk(c, b.uid))];
  return (await serverJson<PagePayload>(res)).blocks.flatMap((b) => walk(b, "page"));
}

/** A {{table}} on `title`: a header and two body rows, each two cells. */
async function seedTable(page: Page, title: RawTitle) {
  const stamp = `${Date.now()}`;
  const uid = (tag: string) => uidOf(`e2etbl${tag}${stamp}`.slice(0, 32));
  const create = (tag: string, parent: string | null, order: number, text: string) =>
    ({ op: "create", uid: uid(tag), page_title: title,
       parent_uid: parent === null ? null : uid(parent), order_idx: order, text });
  const res = await page.request.post("/api/ops", { data: {
    client_id: "e2e-table-edit",
    batch_id: `e2e-table-edit-${stamp}`,
    ops: [
      create("t", null, 0, "{{table}}"),
      create("h", "t", 0, "Name"), create("hh", "h", 0, "Score"),
      create("b", "t", 1, "beta"), create("bb", "b", 0, "2"),
      create("a", "t", 2, "alpha"), create("aa", "a", 0, "1"),
    ],
  } });
  expect(res.ok()).toBeTruthy();
}

test("a plain table edits cells, adds and undoes a row, and sorts without moving blocks",
  async ({ page, ownPage }) => {
    await seedTable(page, ownPage.title);
    await page.reload();
    const table = page.locator("table.data-table");
    const body = table.locator("tbody tr");
    const editor = page.locator("textarea.cell-editor");
    await expect(page.getByText("2 of 2 rows")).toBeVisible();
    await expect(body).toHaveCount(2);

    // edit a cell; Tab commits and opens the next row's first cell, Enter
    // closes it with nothing changed
    await table.getByRole("cell", { name: "2", exact: true }).click();
    await expect(editor).toBeFocused();
    await editor.fill("20");
    await editor.press("Tab");
    await expect(editor).toHaveValue("alpha");
    await editor.press("Enter");
    await expect(editor).toHaveCount(0);
    await expect(body.nth(0)).toContainText("20");
    await expect.poll(() => serverRows(page, ownPage.title)).toEqual(
      [["Name", "Score"], ["beta", "20"], ["alpha", "1"]]);

    // + New row opens its first cell; one undo removes the whole row
    await page.getByRole("button", { name: "+ New row" }).click();
    await expect(body).toHaveCount(3);
    await expect(editor).toBeFocused();
    await expect.poll(() => serverRows(page, ownPage.title)).toEqual(
      [["Name", "Score"], ["beta", "20"], ["alpha", "1"], ["", ""]]);
    await editor.press("Escape");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body).toHaveCount(2);
    await expect.poll(() => serverRows(page, ownPage.title)).toEqual(
      [["Name", "Score"], ["beta", "20"], ["alpha", "1"]]);

    // sorting reorders the rendered rows only
    await table.getByRole("button", { name: "Name" }).click();
    await expect(body.nth(0)).toContainText("alpha");
    await page.reload();
    await expect(page.locator("table.data-table tbody tr").nth(0)).toContainText("beta");
    expect(await serverRows(page, ownPage.title)).toEqual(
      [["Name", "Score"], ["beta", "20"], ["alpha", "1"]]);
  });

test("a keyboard reader tabs into a plain table's cells, opens one with Enter, and keeps their place",
  async ({ page, ownPage }) => {
    await seedTable(page, ownPage.title);
    await page.reload();
    const table = page.locator("table.data-table");
    const editor = page.locator("textarea.cell-editor");
    const cell = (name: string) => table.getByRole("cell", { name, exact: true });
    await expect(page.getByText("2 of 2 rows")).toBeVisible();
    const blocks = await page.locator(".block-tree [data-uid]").count();
    const tree = await serverTree(page, ownPage.title);

    // the first body cell comes after the last header in tab order
    await table.getByRole("button", { name: "Score" }).focus();
    await page.keyboard.press("Tab");
    await expect(cell("beta")).toBeFocused();

    // Enter opens it without typing a newline; Esc gives focus back
    await page.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("beta");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(cell("beta")).toBeFocused();

    // Tab and Shift-Tab between closed cells are the browser's own
    await page.keyboard.press("Tab");
    await expect(cell("2")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cell("beta")).toBeFocused();
    await page.keyboard.press("Tab");

    // Enter commits and leaves focus on the edited cell
    await page.keyboard.press("Enter");
    await editor.fill("3");
    await page.keyboard.press("Enter");
    await expect(editor).toHaveCount(0);
    await expect(cell("3")).toBeFocused();
    await expect.poll(() => serverRows(page, ownPage.title)).toEqual(
      [["Name", "Score"], ["beta", "3"], ["alpha", "1"]]);

    // Tab off the last cell closes it on that cell; the next Tab leaves
    await cell("1").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(editor).toHaveCount(0);
    await expect(cell("1")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "+ New row" })).toBeFocused();

    // none of those keys split, indented or added a block
    await expect(page.locator(".block-tree [data-uid]")).toHaveCount(blocks);
    expect(await serverTree(page, ownPage.title)).toEqual(tree);
    expect(await serverRows(page, ownPage.title)).toEqual(
      [["Name", "Score"], ["beta", "3"], ["alpha", "1"]]);
  });
