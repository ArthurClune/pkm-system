import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

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

const confirmCard = (panel: Locator) => panel.locator(".assistant-confirm-card");

// the fake engine's save_note card: one write to page `title`, text "Demo"
async function expectDemoCard(panel: Locator, title: string) {
  const card = confirmCard(panel);
  await expect(card.locator(".assistant-confirm-action")).toHaveText("save note");
  await expect(card.locator(".assistant-confirm-target").first())
    .toHaveText(`page: ${JSON.stringify(title)}`);
  await expect(card.locator(".assistant-confirm-content"))
    .toHaveText('text: "Demo"');
}

async function openPanel(page: Page): Promise<Locator> {
  await login(page);
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("region", { name: "Assistant" });
  await expect(panel).toBeVisible();
  return panel;
}

// pages a test made, deleted after it whether it passed or not
const createdPages: string[] = [];
test.afterEach(async ({ page }) => {
  for (const title of createdPages.splice(0)) {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});

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
  await expectDemoCard(panel, "Demo");
  await panel.getByRole("button", { name: "Deny" }).click();
  await expect(panel.getByText("Okay, not saving.")).toBeVisible();

  // confirm flow: allow
  await askInput(panel).fill("please write");
  await askInput(panel).press("Enter");
  await expectDemoCard(panel, "Demo");
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

test("two confirms queue: the second waits behind the first", async ({ page }) => {
  const panel = await openPanel(page);
  const card = confirmCard(panel);
  const title = card.locator(".assistant-confirm-title");

  // allow the first, deny the second
  await askInput(panel).fill("please write twice");
  await askInput(panel).press("Enter");
  await expect(title).toHaveText("The assistant wants to make 1 write (1 of 2):");
  await expectDemoCard(panel, "Demo");
  await panel.getByRole("button", { name: "Allow" }).click();
  await expect(title).toHaveText("The assistant wants to make 1 write:");
  await expectDemoCard(panel, "Demo 2");
  await panel.getByRole("button", { name: "Deny" }).click();
  await expect(panel.getByText("Saved 1.")).toBeVisible();
  await expect(panel.getByText("Not saving 2.")).toBeVisible();
  await expect(card).toHaveCount(0);
});

// a short window makes the card taller than the transcript and its ops list
// overflow its own region: the card opens at its heading, and Allow waits
// until the end of the list has also been in view. At these heights a region
// capped at 40vh would not fit the transcript, so a keyboard could never
// bring its end into view.
for (const height of [260, 230]) {
  test(`Allow arms only once the whole card has been in view (${height}px)`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height });
    const panel = await openPanel(page);
    const card = confirmCard(panel);
    const hint = card.getByText("Scroll to the end to review every write");

    await askInput(panel).fill("please write");
    await askInput(panel).press("Enter");
    await expectDemoCard(panel, "Demo");
    await expect(card.locator(".assistant-confirm-title")).toBeInViewport();
    const region = card.getByRole("region", { name: "Writes to review" });
    expect(await region.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(hint).toBeVisible();
    // well past the arming pause, Allow still waits on the scroll
    await page.waitForTimeout(800);
    await expect(panel.getByRole("button", { name: "Allow" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Deny" })).toBeEnabled();

    // the region takes focus, so a keyboard alone can scroll it to the end
    await region.focus();
    await page.keyboard.press("End");
    await expect(region).toBeFocused();
    await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(hint).toHaveCount(0);
    await panel.getByRole("button", { name: "Allow" }).click();
    await expect(panel.getByText("Saved.")).toBeVisible();
  });
}

// shorter still, the list's region (a few lines at least) and the card's
// heading overflow the transcript: scrolled to its end, the transcript holds
// the end marker above its top, and the hint says to scroll back up
test("in a very short window the hint points up to the end it passed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 200 });
  const panel = await openPanel(page);
  const card = confirmCard(panel);
  await askInput(panel).fill("please write");
  await askInput(panel).press("Enter");
  await expectDemoCard(panel, "Demo");
  const region = card.getByRole("region", { name: "Writes to review" });
  await region.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const messages = panel.locator(".assistant-messages");
  await messages.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(card.getByText("Scroll up to bring the end of the list into view"))
    .toBeVisible();
  const allow = panel.getByRole("button", { name: "Allow" });
  await expect(allow).toBeDisabled();
  // scrolling up brings the end marker through view, which arms Allow
  await expect.poll(async () => {
    await messages.evaluate((el) => { el.scrollTop -= 8; });
    return allow.isEnabled();
  }).toBe(true);
});

test("Stop button cancels a hung turn and the conversation stays usable", async ({ page }) => {
  // FakeEngine's "please hang" scenario never yields or
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

// FakeEngine's "please update <uid>" builds its card with the real preview
// over the live store, so the card reads the block as it stands
test("the card shows the current text of the block an update targets", async ({ page }) => {
  const panel = await openPanel(page);
  const card = confirmCard(panel);
  const stamp = Date.now();
  const title = `ApprovalCardTarget${stamp}`;
  const uid = `act${stamp}`;
  createdPages.push(title);
  expect((await page.request.post("/api/pages", { data: { title } })).ok()).toBeTruthy();
  const ops = await page.request.post("/api/ops", { data: {
    client_id: "e2e-approval-card", batch_id: `e2e-approval-card-${stamp}`,
    ops: [{ op: "create", uid, page_title: title, parent_uid: null,
      order_idx: 0, text: "Original text. ".repeat(20) }],
  } });
  expect(ops.ok()).toBeTruthy();

  await askInput(panel).fill(`please update ${uid}`);
  await askInput(panel).press("Enter");
  await expect(card.locator(".assistant-confirm-action")).toHaveText("update block");
  await expect(card).toContainText(`current page: "${title}"`);
  await expect(card.locator(".assistant-confirm-current .assistant-confirm-length"))
    .toHaveText("(first 200 of 300 characters)");
  await panel.getByRole("button", { name: "Deny" }).click();
  await expect(panel.getByText("Not updating.")).toBeVisible();
  await expect(card).toHaveCount(0);

  await askInput(panel).fill("please update nosuchuid99");
  await askInput(panel).press("Enter");
  await expect(card.locator(".assistant-confirm-current"))
    .toHaveText("current text: no block has this uid");
  await panel.getByRole("button", { name: "Deny" }).click();
  await expect(card).toHaveCount(0);
});

type ServerBlock = { text: string; children: ServerBlock[] };

const serverTexts = (blocks: ServerBlock[]): string[] =>
  blocks.flatMap((b) => [b.text, ...serverTexts(b.children)]);

/** Every block text the server holds for page `title`. */
async function serverPageTexts(page: Page, title: string): Promise<string[]> {
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  if (!res.ok()) return [];
  return serverTexts(((await res.json()) as { blocks: ServerBlock[] }).blocks);
}

/** Logs in, makes a page holding one block `uid` with "Shown text.", opens
 * it, and opens the assistant over it. */
async function openBesideBlock(page: Page, title: string, uid: string): Promise<Locator> {
  await login(page);
  createdPages.push(title);
  expect((await page.request.post("/api/pages", { data: { title } })).ok()).toBeTruthy();
  const ops = await page.request.post("/api/ops", { data: {
    client_id: "e2e-approval-guard", batch_id: `e2e-approval-guard-${uid}`,
    ops: [{ op: "create", uid, page_title: title, parent_uid: null,
      order_idx: 0, text: "Shown text." }],
  } });
  expect(ops.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator(".block-text", { hasText: "Shown text." })).toBeVisible();
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("region", { name: "Assistant" });
  await expect(panel).toBeVisible();
  return panel;
}

// FakeEngine's "please update <uid>" runs the real update_block tool on
// Allow, against this server, so the write lands as the assistant's would
test("Allow refuses an update to a block edited after the card showed it", async ({ page }) => {
  test.fail();
  const stamp = Date.now();
  const title = `ApprovalGuard${stamp}`;
  const panel = await openBesideBlock(page, title, `ag${stamp}`);

  await askInput(panel).fill(`please update ag${stamp}`);
  await askInput(panel).press("Enter");
  await expect(confirmCard(panel).locator(".assistant-confirm-action"))
    .toHaveText("update block");

  // the user edits the block with real keypresses while the card waits
  await page.locator(".block-text", { hasText: "Shown text." }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited.");
  await page.keyboard.press("Escape");
  await waitForServerText(page, title, "Shown text. Edited.");

  await panel.getByRole("button", { name: "Allow" }).click();
  await expect(panel.getByText(/changed after the approval card showed it/)).toBeVisible();
  await expect(page.locator(".block-text", { hasText: "Shown text." }))
    .toHaveText("Shown text. Edited.");
  await expect.poll(() => serverPageTexts(page, title)).toContain("Shown text. Edited.");
  await expect.poll(() => serverPageTexts(page, title)).not.toContain("Replaced.");
});

test("Allow applies an update to an unchanged block", async ({ page }) => {
  const stamp = Date.now();
  const title = `ApprovalGuard${stamp}`;
  const panel = await openBesideBlock(page, title, `ag${stamp}`);

  await askInput(panel).fill(`please update ag${stamp}`);
  await askInput(panel).press("Enter");
  await expect(confirmCard(panel).locator(".assistant-confirm-action"))
    .toHaveText("update block");
  await panel.getByRole("button", { name: "Allow" }).click();
  await expect(panel.getByText("Updated.")).toBeVisible();
  await waitForServerText(page, title, "Replaced.");
});
