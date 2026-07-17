// Uploaded-image fullscreen expansion: upload a real image, embed it in a
// block, and verify modal sizing, keyboard access, and every close path.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");
const caretToEnd = (page: Page) =>
  input(page).evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length));

test("uploaded image expands to a contained fullscreen modal", async ({ page }) => {
  await login(page);
  const response = await page.request.post("/api/assets", {
    multipart: { file: { name: "pic.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(response.ok()).toBe(true);
  const { url } = await response.json() as { url: string };

  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();
  const pageTitle = await today.locator("h1.page-title").innerText();
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }
  await input(page).fill(`![pic](${url})`);
  await input(page).press("Escape");

  const trigger = page.getByRole("button", { name: "Expand image: pic" });
  await expect(trigger.getByRole("img", { name: "pic" })).toBeVisible();

  // Native button semantics make Enter open the same viewer as a click.
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Expanded image: pic" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

  const fit = await dialog.evaluate((element) => {
    const stage = element.querySelector<HTMLElement>(".image-overlay-stage")!;
    const image = element.querySelector<HTMLElement>(".image-overlay-image")!;
    const stageRect = stage.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    return {
      objectFit: getComputedStyle(image).objectFit,
      inside:
        imageRect.left >= stageRect.left &&
        imageRect.top >= stageRect.top &&
        imageRect.right <= stageRect.right &&
        imageRect.bottom <= stageRect.bottom,
    };
  });
  expect(fit).toEqual({ objectFit: "contain", inside: true });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

  await trigger.click();
  await dialog.locator(".image-overlay-stage").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toHaveCount(0);

  await trigger.click();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // All specs share one server database, so remove this test's image before
  // later tests use deliberately broad image/button locators.
  const imageRow = page.locator(".block-row", { has: trigger }).first();
  await imageRow.locator(".block-text").evaluate((element: HTMLElement) => element.click());
  await expect(input(page)).toBeFocused();
  const cleanupMarker = "image expansion e2e complete";
  await input(page).fill(cleanupMarker);
  await input(page).press("Escape");
  await expect(trigger).toHaveCount(0);
  await waitForServerText(page, pageTitle, cleanupMarker);
});
