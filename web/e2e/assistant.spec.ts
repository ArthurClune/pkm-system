import { type Locator, type Page } from "@playwright/test";
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

const askInput = (panel: Locator) => panel.getByPlaceholder(/ask about your notes/i);

test("assistant panel: toggle, echo turn, confirm allow/deny", async ({ page }) => {
  await login(page);

  // Open via keyboard. The app handler checks `e.metaKey || e.ctrlKey`, so
  // Control+j (rather than a platform-specific Meta/Control branch) works
  // the same everywhere Playwright's synthetic key events reach the page.
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("region", { name: "Assistant" });
  await expect(panel).toBeVisible();

  // model dropdown enabled before first message
  await expect(panel.getByLabel("model")).toBeEnabled();

  // echo turn
  await askInput(panel).fill("hello there");
  await askInput(panel).press("Enter");
  await expect(panel.getByText("echo: hello there")).toBeVisible();
  await expect(panel.getByLabel("model")).toBeDisabled();

  // confirm flow: deny
  await askInput(panel).fill("please write");
  await askInput(panel).press("Enter");
  await expect(panel.getByText('save_note(title="Demo")')).toBeVisible();
  await panel.getByRole("button", { name: "Deny" }).click();
  await expect(panel.getByText("Okay, not saving.")).toBeVisible();

  // confirm flow: allow
  await askInput(panel).fill("please write");
  await askInput(panel).press("Enter");
  await expect(panel.getByText('save_note(title="Demo")')).toBeVisible();
  await panel.getByRole("button", { name: "Allow" }).click();
  await expect(panel.getByText("Saved.")).toBeVisible();

  // Esc closes only when focus is inside the panel
  await askInput(panel).click();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();

  // sidebar entry reopens
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByRole("region", { name: "Assistant" })).toBeVisible();
});

test("Stop button cancels a hung turn and the conversation stays usable", async ({ page }) => {
  // pkm-c98s item 3. FakeEngine's "please hang" scenario never yields or
  // finishes, so only a genuine abort (AbortController -> fetch abort ->
  // server-side cancellation) can end the turn.
  await login(page);
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("region", { name: "Assistant" });
  await expect(panel).toBeVisible();

  await askInput(panel).fill("please hang");
  await askInput(panel).press("Enter");
  const stopButton = panel.getByRole("button", { name: "Stop" });
  await expect(stopButton).toBeVisible();
  await stopButton.click();
  await expect(panel.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(panel.getByPlaceholder(/ask about your notes/i)).toBeEnabled();

  // the conversation is not wedged: a normal turn still works afterwards
  await askInput(panel).fill("hello again");
  await askInput(panel).press("Enter");
  await expect(panel.getByText("echo: hello again")).toBeVisible();
});

test("pagehide closes the live conversation via sendBeacon", async ({ page }) => {
  // pkm-c98s item 1
  await login(page);
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("region", { name: "Assistant" });
  await askInput(panel).fill("hello");
  await askInput(panel).press("Enter");
  await expect(panel.getByText("echo: hello")).toBeVisible();

  const beacon = page.waitForRequest(
    (req) => req.method() === "POST" && /\/api\/assistant\/conversations\/[0-9a-f]+$/.test(req.url()),
    { timeout: 5000 },
  );
  await page.goto("about:blank"); // fires `pagehide` on the outgoing document
  await beacon;
});
