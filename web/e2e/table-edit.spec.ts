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
