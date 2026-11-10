// Extends the shared `test` with scratch pages: a uniquely named page created
// through the API, opened in the browser and deleted after the test. Specs
// write here instead of into today's journal, which every spec shares.
//
// `ownPage` logs in and opens one page before the test body. A spec that must
// install routes or WebSocket handlers before the first load, or that logs in
// itself, uses `scratch.open()` after its own login instead.
import { expect, test as base } from "./fixtures";

const PASSWORD = "e2e-pw";

export type OwnPage = { title: string };
export type Scratch = { open: () => Promise<string> };

export const test = base.extend<{ scratch: Scratch; ownPage: OwnPage }>({
  scratch: async ({ page }, use, testInfo) => {
    const titles: string[] = [];
    const slug = testInfo.title.replace(/[^A-Za-z0-9]+/g, " ").trim().slice(0, 30);
    await use({
      open: async () => {
        const title = `e2e ${slug} ${Date.now()}`;
        const created = await page.request.post("/api/pages", { data: { title } });
        expect(created.ok()).toBeTruthy();
        titles.push(title);
        await page.goto(`/page/${encodeURIComponent(title)}`);
        return title;
      },
    });
    for (const title of titles) {
      await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
    }
  },

  ownPage: async ({ page, scratch }, use) => {
    await page.goto("/login");
    await page.fill("#pw", PASSWORD);
    await page.click("text=log in");
    await page.waitForURL("**/");
    // wait until the websocket is up (editing unpauses)
    await expect(page.locator(".ws-banner")).toHaveCount(0);
    await use({ title: await scratch.open() });
  },
});

export { expect };
