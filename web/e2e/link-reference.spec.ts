import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";
const input = (page: Page) => page.locator("textarea.block-input");

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

async function createPage(page: Page, title: string) {
  const response = await page.request.post("/api/pages", { data: { title } });
  expect(response.ok()).toBeTruthy();
}

async function waitForText(page: Page, pageTitle: string, text: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/page/${encodeURIComponent(pageTitle)}`);
    if (!response.ok()) return false;
    const payload = await response.json() as { blocks: { text: string }[] };
    return payload.blocks.some((block) => block.text === text);
  }, { timeout: 20_000 }).toBe(true);
}

test("links a differently cased plain mention with canonical casing (pkm-965i)", async ({ page }) => {
  const stamp = Date.now();
  const target = `LinkTarget${stamp}`;
  const source = `LinkSource${stamp}`;
  const original = `${target.toLowerCase()} created the jumbotron`;
  const linked = `[[${target}]] created the jumbotron`;
  await login(page);
  await createPage(page, target);
  await createPage(page, source);
  await page.goto(`/page/${encodeURIComponent(source)}`);
  await page.getByText("Click to start writing…").click();
  await input(page).fill(original);
  await input(page).press("Escape");
  await waitForText(page, source, original);

  await page.goto(`/page/${encodeURIComponent(target)}`);
  await page.locator(".unlinked .section-header").click();
  const group = page.locator(".unlinked .backlink-group", { hasText: source });
  await group.getByRole("button", { name: "Link" }).click();
  await waitForText(page, source, linked);
  await expect(group).toHaveCount(0);
  await expect(page.locator(".backlinks .backlink-group", { hasText: source })).toBeVisible();
});

test("preserves Markdown and appends a canonical tag (pkm-965i)", async ({ page }) => {
  const stamp = Date.now();
  const target = `MarkdownTarget${stamp}`;
  const source = `MarkdownSource${stamp}`;
  const href = `https://example.test/${target.toLowerCase()}/study.md`;
  const original = `[A study](${href}) shows great things`;
  const linked = `${original} #[[${target}]]`;
  await login(page);
  await createPage(page, target);
  await createPage(page, source);
  await page.goto(`/page/${encodeURIComponent(source)}`);
  await page.getByText("Click to start writing…").click();
  await input(page).fill(original);
  await input(page).press("Escape");
  await waitForText(page, source, original);

  await page.goto(`/page/${encodeURIComponent(target)}`);
  await page.locator(".unlinked .section-header").click();
  const group = page.locator(".unlinked .backlink-group", { hasText: source });
  await group.getByRole("button", { name: "Link" }).click();
  await waitForText(page, source, linked);
  const backlink = page.locator(".backlinks .backlink-group", { hasText: source });
  await expect(backlink.locator(`a[href="${href}"]`)).toHaveText("A study");
  await expect(backlink.getByRole("link", { name: target })).toBeVisible();
});
