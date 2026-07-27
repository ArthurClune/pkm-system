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

test("a [[daily note]] reference from another page shows under that day " +
     "on the journal scroll (pkm-vvta)", async ({ page }) => {
  // Written entirely on a separate, uniquely-named page -- today's own
  // daily note is never touched, so this can't collide with edit.spec.ts's
  // "today starts empty" assumption.
  const src = `JournalRefSrc${Date.now()}`;
  await login(page);

  // Read today's title off the rendered journal (already on screen after
  // login) rather than a side-channel request: that gives the client's own
  // sync/replica pipeline the same head start a real user gets before we
  // reference the page from elsewhere, instead of racing it.
  const todayTitle = await page.locator(".journal-day .page-title a").first()
    .innerText();
  // Give the client's background replica sync a beat to catch up with
  // today's page before referencing it from elsewhere (pkm-c9hp: editing a
  // page the local replica hasn't hydrated yet can trip a legacy-rejected
  // repair that discards the in-flight edit).
  await page.waitForTimeout(1500);

  const createRes = await page.request.post("/api/pages", { data: { title: src } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(src)}`);
  await page.getByText("Click to start writing…").click();
  await input(page).fill(`Remind me on [[${todayTitle}]] to check this`);
  await input(page).press("Escape");

  // Poll until the block lands server-side (async delivery over the
  // offline queue, same reasoning as backlink-filter.spec.ts).
  await expect.poll(async () => {
    const res = await page.request.get(
      `/api/page/${encodeURIComponent(todayTitle)}`);
    if (!res.ok()) return false;
    const body = await res.json() as {
      backlinks: { groups: { page_title: string; items: { text: string }[] }[] };
    };
    return body.backlinks.groups.some((g) => g.page_title === src);
  }, { timeout: 20_000 }).toBe(true);

  await page.goto("/");
  const daySection = page.locator(".journal-day")
    .filter({ has: page.locator(".page-title", { hasText: todayTitle }) });
  await expect(daySection.locator(".backlinks .section-header"))
    .toContainText("Linked references (1)");
  await expect(daySection.locator(".backlink-item"))
    .toContainText("Remind me on");
  await expect(daySection.locator(".backlinks .group-title"))
    .toContainText(src);
});
