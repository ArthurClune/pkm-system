// A {{query}} block shows its records as a table whose cells write back to
// the record's page, and "Save this view" keeps the filter in the macro's
// own text across a reload.
import type { Locator } from "@playwright/test";
import type { RawTitle } from "../src/api/brands";
import { rawTitleOf } from "../src/test-mint";
import { expect, test } from "./ownPage";
import { waitForServerText } from "./server-state";

const seeded: RawTitle[] = [];

test.afterEach(async ({ page }) => {
  for (const title of seeded.splice(0)) {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});

async function cellIn(table: Locator, rowText: string, column: string) {
  const headers = await table.getByRole("columnheader").allTextContents();
  const at = headers.findIndex((h) => h.startsWith(column));
  expect(at).toBeGreaterThan(0);
  return table.getByRole("row").filter({ hasText: rowText })
    .getByRole("cell").nth(at);
}

test("a query table writes a cell to its page, and Save keeps the filter",
     async ({ page, ownPage }) => {
  const stamp = Date.now();
  const tag = `e2e query table ${stamp}`;
  const alpha = rawTitleOf(`Book/e2e Alpha ${stamp}`);
  const beta = rawTitleOf(`Book/e2e Beta ${stamp}`);
  for (const title of [alpha, beta]) {
    const made = await page.request.post("/api/pages", { data: { title } });
    expect(made.ok()).toBeTruthy();
    seeded.push(title);
  }
  // The tag page comes into being with the first ref to it.
  seeded.push(rawTitleOf(tag));
  const expr = `{and: [[${tag}]]}`;
  const lines = (title: RawTitle, author: string, n: number) =>
    [`Type:: [[${tag}]]`, `Author:: ${author}`, "Reading Status:: Unread"]
      .map((text, i) => ({
        op: "create", uid: `e2eqt${stamp}${n}${i}`, page_title: title,
        parent_uid: null, order_idx: i, text,
      }));
  const ops = await page.request.post("/api/ops", { data: {
    client_id: "e2e-query-table",
    batch_id: `e2e-query-table-${stamp}`,
    ops: [
      ...lines(alpha, "Xavier", 1), ...lines(beta, "Yolanda", 2),
      { op: "create", uid: `e2eqt${stamp}q`, page_title: ownPage.title,
        parent_uid: null, order_idx: 0, text: `{{query: ${expr}}}` },
    ],
  } });
  expect(ops.ok()).toBeTruthy();
  await page.reload();

  const table = page.locator(".query-block table.data-table");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(page.getByText("2 of 2 results")).toBeVisible();

  await (await cellIn(table, alpha, "Reading Status")).click();
  const editor = page.locator("textarea.cell-editor");
  await expect(editor).toHaveValue("Unread");
  await editor.fill("Read");
  await editor.press("Tab");
  // Tab committed and opened the next cell, the first of the next row.
  await expect(editor).toHaveValue(`[[${tag}]]`);
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  await waitForServerText(page, alpha, "Reading Status:: Read");
  await expect(await cellIn(table, alpha, "Reading Status")).toHaveText("Read");
  await expect(page.getByText(`Reading Status:: Read written to ${alpha}`))
    .toBeVisible();

  await page.getByRole("searchbox", { name: "Filter" }).fill("author:x");
  await expect(page.getByText("1 of 2 results")).toBeVisible();
  await page.getByRole("button", { name: "Save this view" }).click();
  await expect(page.getByText("✓ saved view")).toBeVisible();
  await waitForServerText(page, ownPage.title,
                          `{{query: ${expr} | filter: author:x}}`);

  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Filter" }))
    .toHaveValue("author:x");
  await expect(page.getByText("1 of 2 results")).toBeVisible();
});
