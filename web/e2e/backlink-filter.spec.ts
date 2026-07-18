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

test("linked-refs filter: include, exclude, ancestor tags (pkm-m4an)", async ({ page }) => {
  // unique target *and* source pages per run: the e2e DB is shared across
  // specs/retries. The scenario's blocks are written to a dedicated `src`
  // page rather than today's journal — the journal is shared and
  // order-sensitive across the whole suite (edit.spec.ts's "core editing
  // loop" hard-assumes today starts empty, with no fallback branch, and
  // relies on running before any other spec touches it; rename.spec.ts's
  // "renaming onto an existing page" test shows the established precedent
  // for scratch content instead: write directly onto a fresh, uniquely
  // named non-journal page). Creating `src` explicitly via POST /api/pages
  // guarantees it exists and is empty before we navigate to it, independent
  // of suite/file run order.
  const tgt = `FilterTgt${Date.now()}`;
  const src = `FilterSrc${Date.now()}`;
  await login(page);

  const createRes = await page.request.post("/api/pages", { data: { title: src } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(src)}`);
  await page.getByText("Click to start writing…").click();

  // A trailing space after each "#Tag" closes the tag-autocomplete context
  // (detectAutocomplete in outline/autocomplete.ts re-opens it whenever the
  // caret sits right after a bare "#word" with no trailing whitespace, and
  // fill() leaves the caret at the very end of the value). Without it the
  // popup's always-present "new tag" row swallows the next Enter as an
  // ac-pick no-op instead of splitting the block — verified by instrumenting
  // the test: every block after the first stayed absent server-side because
  // Enter never split.
  await input(page).fill(`alpha [[${tgt}]] #FTagA `);
  await input(page).press("Enter");
  await input(page).fill(`beta [[${tgt}]] #FTagB `);
  await input(page).press("Enter");
  await input(page).fill("parent block #FTagC ");
  await input(page).press("Enter");
  await input(page).press("Tab"); // nest under "parent block #FTagC"
  await input(page).fill(`gamma [[${tgt}]]`);
  await input(page).press("Escape");

  // Escape blurs and flushes the draft op, but delivery to the server is
  // async (offline queue, drained strictly FIFO). A bare 200 from
  // /api/page/<tgt> only proves the FIRST queued op (alpha's) landed, not
  // that beta/parent/gamma have too — and PageView fetches once on mount
  // with no live refresh, so navigating early can hard-fail the later chip
  // assertions. Poll until gamma's block (the last one created) shows up in
  // the target page's backlinks; FIFO drain order means everything queued
  // before it has landed by then too (brief troubleshooting note).
  await expect.poll(async () => {
    const res = await page.request.get(`/api/page/${encodeURIComponent(tgt)}`);
    if (!res.ok()) return false;
    const body = await res.json() as {
      backlinks: { groups: { items: { text: string }[] }[] };
    };
    return body.backlinks.groups.some((g) =>
      g.items.some((it) => it.text.includes(`gamma [[${tgt}]]`)));
  }, { timeout: 20_000 }).toBe(true);

  await page.goto(`/page/${tgt}`);
  const header = page.locator(".backlinks .section-header");
  await expect(header).toContainText("Linked references (1)"); // 1 source page

  await page.click(".filter-toggle");
  const chip = (label: string) =>
    page.locator(".filter-candidates .filter-chip", { hasText: label });

  // include FTagA -> only alpha; header shows N of M
  await chip("FTagA").click();
  await expect(page.locator(".backlink-item")).toHaveCount(1);
  await expect(page.locator(".backlink-item")).toContainText("alpha");
  await expect(header).toContainText("(1 of 1)");

  // clear, exclude FTagA -> beta and gamma remain
  await page.click(".filter-clear");
  await chip("FTagA").click({ modifiers: ["Shift"] });
  await expect(page.locator(".backlink-item")).toHaveCount(2);
  await expect(page.locator(".backlink-item").filter({ hasText: "alpha" })).toHaveCount(0);

  // ancestor inheritance: include FTagC (parent's tag) -> gamma only
  await page.click(".filter-clear");
  await chip("FTagC").click();
  await expect(page.locator(".backlink-item")).toHaveCount(1);
  await expect(page.locator(".backlink-item")).toContainText("gamma");

  // exclude everything -> empty state message
  await page.click(".filter-clear");
  await chip("FTagA").click({ modifiers: ["Shift"] });
  await chip("FTagB").click({ modifiers: ["Shift"] });
  await chip("FTagC").click({ modifiers: ["Shift"] });
  await expect(page.locator(".filter-no-match")).toBeVisible();
  await expect(page.locator(".backlink-item")).toHaveCount(0);
});
