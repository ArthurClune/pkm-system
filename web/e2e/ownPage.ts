// Extends the shared `test` with an `ownPage` fixture: a uniquely named page
// created through the API, opened in the browser, and deleted afterwards.
// Specs write here instead of into today's journal, which every spec shares.
import { expect, test as base } from "./fixtures";

const PASSWORD = "e2e-pw";

export type OwnPage = { title: string };

export const test = base.extend<{ ownPage: OwnPage }>({
  ownPage: async ({ page }, use, testInfo) => {
    await page.goto("/login");
    await page.fill("#pw", PASSWORD);
    await page.click("text=log in");
    await page.waitForURL("**/");
    // wait until the websocket is up (editing unpauses)
    await expect(page.locator(".ws-banner")).toHaveCount(0);

    const slug = testInfo.title.replace(/[^A-Za-z0-9]+/g, " ").trim().slice(0, 30);
    const title = `e2e ${slug} ${Date.now()}`;
    const created = await page.request.post("/api/pages", { data: { title } });
    expect(created.ok()).toBeTruthy();
    await page.goto(`/page/${encodeURIComponent(title)}`);

    await use({ title });

    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  },
});

export { expect };
