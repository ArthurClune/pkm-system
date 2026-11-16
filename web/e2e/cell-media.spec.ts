// Media in a table cell stays one line: a query table's local-copy PDF
// (the e2e server seeds Papers/sample.pdf) opens full screen over the table
// and Escape returns to it as it was, and a plain table's mermaid cell goes
// to the cell's own line.
//
// The query names a tag page that comes into being with the first ref to
// it; the server refuses to delete a page a query macro names, so the query
// block goes before the tag and paper pages do.
import type { RawTitle } from "../src/api/brands";
import { rawTitleOf } from "../src/test-mint";
import { expect, test } from "./ownPage";

const seeded: RawTitle[] = [];
const queryBlocks: string[] = [];

test.afterEach(async ({ page }) => {
  for (const uid of queryBlocks.splice(0)) {
    const ops = await page.request.post("/api/ops", { data: {
      client_id: "e2e-cell-media", batch_id: `e2e-cell-media-rm-${uid}`,
      ops: [{ op: "delete", uid }],
    } });
    expect(ops.ok(), `delete block ${uid}: ${ops.status()}`).toBeTruthy();
  }
  for (const title of seeded.splice(0)) {
    const gone = await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
    expect(gone.ok(), `delete ${title}: ${gone.status()}`).toBeTruthy();
  }
});

test("media in table cells is a label that opens full screen or goes to its line",
     async ({ page, ownPage }) => {
  const stamp = Date.now();
  const tag = `CellMediaE2E${stamp}`;
  const paper = rawTitleOf(`Paper/e2e cell media ${stamp}`);
  const made = await page.request.post("/api/pages", { data: { title: paper } });
  expect(made.ok()).toBeTruthy();
  seeded.push(paper, rawTitleOf(tag));

  const uid = (tag: string) => `e2ecm${stamp}${tag}`;
  const queryUid = uid("q");
  queryBlocks.push(queryUid);
  const create = (u: string, title: RawTitle, parent: string | null,
                  order: number, text: string) =>
    ({ op: "create", uid: u, page_title: title, parent_uid: parent,
       order_idx: order, text });
  const mermaidUid = uid("bb");
  const ops = await page.request.post("/api/ops", { data: {
    client_id: "e2e-cell-media",
    batch_id: `e2e-cell-media-${stamp}`,
    ops: [
      create(uid("p0"), paper, null, 0, `Tags:: #${tag}`),
      create(uid("p1"), paper, null, 1, "Local copy:: [sample.pdf](/api/local/Papers/sample.pdf)"),
      create(queryUid, ownPage.title, null, 0, `{{query: {and: [[${tag}]]}}}`),
      create(uid("t"), ownPage.title, null, 1, "{{table}}"),
      create(uid("h"), ownPage.title, uid("t"), 0, "Name"),
      create(uid("hh"), ownPage.title, uid("h"), 0, "Diagram"),
      create(uid("b"), ownPage.title, uid("t"), 1, "flow"),
      create(mermaidUid, ownPage.title, uid("b"), 0,
             "```mermaid\ngraph TD; A-->B\n```"),
    ],
  } });
  expect(ops.ok()).toBeTruthy();
  await page.reload();

  // The query table: the PDF row stays table-sized and shows the label.
  const query = page.locator(".query-block table.data-table");
  const row = query.locator("tbody tr").filter({ hasText: "e2e cell media" });
  await expect(row).toHaveCount(1);
  const label = row.getByRole("button", { name: "Open PDF full screen: sample.pdf" });
  await expect(label).toHaveText("📄 sample.pdf");
  await expect(row.locator(".pdf-embed, .pdf-frame")).toHaveCount(0);
  expect((await row.boundingBox())!.height).toBeLessThan(80);

  // Full screen and back: the filter typed first is still there.
  const filter = page.locator(".query-block").getByRole("searchbox", { name: "Filter" });
  await filter.fill("cell media");
  await label.click();
  const dialog = page.getByRole("dialog", { name: "sample.pdf" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("canvas").first()).toBeVisible();
  // The frame fits the overlay and a wheel scrolls it to the later pages.
  const frame = dialog.locator(".pdf-frame");
  await frame.hover();
  await page.mouse.wheel(0, 800);
  await expect.poll(() => frame.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(label).toBeFocused();
  await expect(filter).toHaveValue("cell media");
  await expect(page.locator("textarea.cell-editor")).toHaveCount(0);

  // The plain table: the mermaid cell goes to its own line on this page.
  const plain = page.locator("table.data-table").filter({ hasText: "flow" });
  const line = plain.getByRole("button", { name: "↗ Mermaid diagram" });
  await expect(plain.locator(".mermaid-diagram, svg")).toHaveCount(0);
  const path = new URL(page.url()).pathname;
  await line.click();
  await expect(page).toHaveURL((u) => u.pathname === path && u.hash === `#${mermaidUid}`);
  await expect(plain.locator(`td[data-cell-uid="${mermaidUid}"]`))
    .toHaveClass(/flash-target/);
  await expect(page.locator("textarea.cell-editor")).toHaveCount(0);

  await line.click({ modifiers: ["Shift"] });
  await expect(page.locator(".sidebar-panel-title")).toHaveText(ownPage.title);
});
