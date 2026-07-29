// /today, /tomorrow and /date slash-command shortcuts (pkm-rw6w): each
// inserts a [[daily-note]] link. /today and /tomorrow apply directly;
// /date opens an inline picker (DatePickerPopup) and inserts on mousedown.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

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

test("/today inserts a link to today's daily note", async ({ page }) => {
  await login(page);

  // Read today's title off the rendered journal rather than re-deriving the
  // "Month Dth, YYYY" format (journal-references.spec.ts idiom).
  const todayTitle = await page.locator(".journal-day .page-title a").first()
    .innerText();
  // Give the client's background replica sync a beat to catch up with
  // today's page before referencing it from elsewhere (journal-references.
  // spec.ts precedent; pkm-c9hp: editing/referencing a page the local
  // replica hasn't hydrated yet can trip a legacy-rejected repair that
  // discards the in-flight edit -- SyncProvider.tsx's legacy-rejected
  // handling is live, not dead code).
  await page.waitForTimeout(1500);

  // Never write into today's journal (other specs assume it starts empty) --
  // a fresh, uniquely-named page is the established scratch idiom
  // (backlink-filter.spec.ts / linked-refs filter spec).
  const src = `slash dates ${Date.now()}`;
  const createRes = await page.request.post("/api/pages", { data: { title: src } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(src)}`);
  await page.getByText("Click to start writing…").click();

  await input(page).fill("/today");
  // Popup rows pick on mousedown; click() still delivers it (mousedown fires
  // before the click's mouseup/up sequence completes).
  await page.getByRole("option", { name: "link to today" }).click();

  await expect(input(page)).toHaveValue(`[[${todayTitle}]]`);
});

test("/date picker inserts the clicked date's link", async ({ page }) => {
  await login(page);
  // Same fresh-page-references-a-daily-note shape as the /today test above:
  // the picker defaults to the current month, so day 15 IS today's page
  // whenever the suite happens to run on the 15th. Give replica sync the
  // same catch-up beat unconditionally rather than special-casing that one
  // date (journal-references.spec.ts precedent; pkm-c9hp).
  await page.waitForTimeout(1500);

  const src = `slash dates date ${Date.now()}`;
  const createRes = await page.request.post("/api/pages", { data: { title: src } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(src)}`);
  await page.getByText("Click to start writing…").click();

  await input(page).fill("/date");
  await page.getByRole("option", { name: "link to a date…" }).click();

  const dialog = page.getByRole("dialog", { name: "pick a date" });
  await expect(dialog).toBeVisible();
  // Every day/nav control in the picker handles onMouseDown (not onClick) so
  // the textarea never loses focus (DatePickerPopup.tsx); the day button may
  // unmount before mouseup fires, so dispatchEvent("mousedown") is the
  // deterministic way to trigger the pick (a plain .click() can flake).
  await dialog.getByRole("button", { name: "15", exact: true })
    .dispatchEvent("mousedown");

  await expect(input(page)).toHaveValue(/^\[\[[A-Z][a-z]+ 15th, \d{4}\]\]$/);
});
