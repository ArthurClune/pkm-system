// An empty Paper/ page seeds the Paper template from
// web/src/templates/Paper.md, with the caret at the end of Tags::: on
// "Click to start writing…", and on arrival from search's "Create page" or a
// followed link.
import type { Page } from "@playwright/test";
import type { RawTitle } from "../src/api/brands";
import type { PagePayload } from "../src/api/payloads";
import { rawTitleOf } from "../src/test-mint";
import { expect, test } from "./ownPage";
import { waitForServerText } from "./server-state";
import { serverJson } from "./wireJson";

/** The seeded template is on screen with the caret in Tags::, so that
 * block shows as its textarea and the rest as attributes. */
async function expectSeeded(page: Page) {
  await expect(page.locator("textarea.block-input")).toHaveValue("Tags:: #Paper");
  await expect(page.locator(".attribute"))
    .toHaveText(["URL", "Date", "Local copy"]);
}

const pageUrl = (title: RawTitle) => `/api/page/${encodeURIComponent(title)}`;

async function serverBlockCount(page: Page, title: RawTitle): Promise<number> {
  const res = await page.request.get(pageUrl(title));
  return res.ok() ? (await serverJson<PagePayload>(res)).blocks.length : -1;
}

test("start-writing on a Paper/ page seeds its attribute blocks", async ({
  page, ownPage: _ownPage, scratch,
}) => {
  const title = await scratch.open("Paper/");
  await page.getByText("Click to start writing…").click();
  await page.keyboard.type(" #AI");
  // The first Escape closes the tag popup, the second stops editing.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitForServerText(page, title, "Tags:: #Paper #AI");
  await waitForServerText(page, title, "Local copy:: ");

  await page.reload();
  await expect(page.locator(".attribute")).toHaveText(
    ["Tags", "URL", "Date", "Local copy"]);
});

test("search create seeds a Paper/ page once", async ({
  page, ownPage: _ownPage,
}) => {
  const title = rawTitleOf(`Paper/e2e search ${Date.now()}`);
  try {
    await page.getByLabel("Search").fill(title);
    await page.locator(".search-result",
                       { hasText: `Create page "${title}"` }).click();
    await expect(page.locator("h1.page-title")).toHaveText(title);
    await expectSeeded(page);
    await waitForServerText(page, title, "Local copy:: ");

    // Undone, then reloaded: the history entry no longer carries the marker,
    // so the page stays empty.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => serverBlockCount(page, title)).toBe(0);
    await page.reload();
    await expect(page.getByText("Click to start writing…")).toBeVisible();
    expect(await serverBlockCount(page, title)).toBe(0);
  } finally {
    await page.request.delete(pageUrl(title));
  }
});

/** Writes a block linking to `linked` on the scratch page, so the server
 * creates `linked` empty from the reference, as a typed link does. */
async function linkFrom(page: Page, from: RawTitle, linked: RawTitle) {
  const res = await page.request.post("/api/ops", { data: {
    client_id: "e2e-page-template",
    batch_id: `e2e-page-template-${Date.now()}`,
    ops: [{ op: "create", uid: `pt${Date.now().toString(36)}`,
            page_title: from, parent_uid: null, order_idx: 0,
            text: `read [[${linked}]]` }] } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
}

test("following a link seeds a new Paper/ page", async ({
  page, ownPage,
}) => {
  const linked = rawTitleOf(`Paper/e2e link ${Date.now()}`);
  try {
    await linkFrom(page, ownPage.title, linked);
    await page.locator(".page-link", { hasText: linked }).click();
    await expect(page.locator("h1.page-title")).toHaveText(linked);
    await expectSeeded(page);
    await waitForServerText(page, linked, "Tags:: #Paper");
  } finally {
    await page.request.delete(pageUrl(linked));
  }
});

test("shift-click seeds a new Paper/ page in the sidebar once", async ({
  page, ownPage,
}) => {
  const linked = rawTitleOf(`Paper/e2e sidebar ${Date.now()}`);
  try {
    await linkFrom(page, ownPage.title, linked);
    await page.locator(".page-link", { hasText: linked })
      .click({ modifiers: ["Shift"] });
    const panel = page.getByRole("region", { name: `sidebar: ${linked}` });
    await expect(panel.locator("textarea.block-input"))
      .toHaveValue("Tags:: #Paper");
    await waitForServerText(page, linked, "Local copy:: ");

    // Undone, then the sidebar hidden and re-shown, which remounts the
    // panel: its entry no longer carries the marker.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => serverBlockCount(page, linked)).toBe(0);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(panel).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(panel.getByText("Click to start writing…")).toBeVisible();
    expect(await serverBlockCount(page, linked)).toBe(0);
  } finally {
    await page.request.delete(pageUrl(linked));
  }
});
