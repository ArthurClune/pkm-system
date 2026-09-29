// A write another device lands while this tab's batch is in flight must not
// lose either side's text: the server applies the incoming edit and puts
// the other text on today's daily note, under a [[conflict]] header naming
// the block's page. An edit to a block another device deleted is skipped
// in the ack and its text lands on today's note the same way. Both are
// driven through the real editor, queue, ops route and feed: the browser's
// POST /api/ops is held in a route handler while the other device writes
// through page.request, which page routes do not intercept.
//
// Today's journal is shared by every spec, so each test deletes exactly the
// entries it caused (keyed by its own stamped page title) and checks that
// the day's top-level blocks are the ones it found.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PASSWORD = "e2e-pw";

type BlockNode = { uid: string; text: string; children: BlockNode[] };
type SkippedOp = { uid: string; op: string; reason: string };
type Ack = { skipped?: SkippedOp[] };

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const pageBlocks = async (page: Page, title: string): Promise<BlockNode[]> => {
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json() as { blocks: BlockNode[] }).blocks;
};

interface Scenario {
  title: string;
  today: string;
  u1: string;
  remote: (id: string, ops: object[]) => Promise<void>;
}

/** Logs in, notes today's journal as found, creates a stamped page holding
 * one block (`base`) through another client, opens it, runs `body`, and
 * always puts back what the test changed. */
async function withScenario(page: Page, label: string, base: string,
                            body: (s: Scenario) => Promise<void>) {
  const stamp = Date.now();
  const title = `${label} ${stamp}`;
  const u1 = `e2ecfl${stamp}`.slice(0, 32);
  const remote = async (id: string, ops: object[]) => {
    const res = await page.request.post("/api/ops", { data: {
      client_id: "e2e-remote-conflict", batch_id: `e2e-cfl-${id}-${stamp}`, ops,
    } });
    expect(res.ok()).toBeTruthy();
  };

  await login(page);
  const today = await page.locator(".journal-day").first()
    .locator("h1.page-title").innerText();
  const before = (await pageBlocks(page, today)).map((b) => b.uid);
  const conflictExisted =
    (await page.request.get("/api/page/conflict")).ok();
  try {
    expect((await page.request.post("/api/pages", { data: { title } })).ok())
      .toBeTruthy();
    await remote("seed", [{ op: "create", uid: u1, page_title: title,
                            parent_uid: null, order_idx: 0, text: base }]);
    await page.goto(`/page/${encodeURIComponent(title)}`);
    await expect(page.locator(".block-text", { hasText: base })).toBeVisible();
    await body({ title, today, u1, remote });
  } finally {
    const added = (await pageBlocks(page, today))
      .filter((b) => !before.includes(b.uid) && b.text.includes(title));
    if (added.length > 0) {
      await remote("cleanup", added.map((b) => ({ op: "delete", uid: b.uid })));
    }
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
    if (!conflictExisted) await page.request.delete("/api/page/conflict");
    expect((await pageBlocks(page, today)).map((b) => b.uid)).toEqual(before);
  }
}

/** Holds this tab's first update_text batch for `uid`: `first` runs (the
 * other device's write), then the batch reaches the server. Resolves with
 * the server's ack. */
async function holdEditTo(page: Page, uid: string,
                          first: () => Promise<void>): Promise<() => Ack | null> {
  let ack: Ack | null = null;
  let held = false;
  await page.route("**/api/ops", async (route) => {
    const batch = route.request().postDataJSON() as {
      ops: { op: string; uid?: string }[];
    };
    const hits = batch.ops.some((op) => op.op === "update_text" && op.uid === uid);
    if (held || !hits) {
      await route.continue();
      return;
    }
    held = true;
    await first();
    const response = await route.fetch();
    ack = await response.json() as Ack;
    await route.fulfill({ response });
  });
  return () => ack;
}

async function editBlock(page: Page, from: string, to: string) {
  await page.locator(".block-text", { hasText: from }).click();
  const input = page.locator("textarea.block-input");
  await expect(input).toBeFocused();
  await input.fill(to);
  await input.press("Escape"); // blur flushes the draft
}

const landing = (blocks: BlockNode[], header: string) =>
  blocks.find((b) => b.text === header);

test("a concurrent edit lands the overwritten text under a conflict header on today's note",
async ({ page }) => {
  test.setTimeout(60_000);
  await withScenario(page, "Conflict Landing", "conflict base", async (s) => {
    const lost = "remote edit wins the race";
    const ack = await holdEditTo(page, s.u1, () =>
      s.remote("edit", [{ op: "update_text", uid: s.u1, text: lost }]));

    await editBlock(page, "conflict base", "conflict base local");
    await expect.poll(ack).not.toBeNull();
    expect(ack()!.skipped ?? []).toEqual([]);

    // the incoming (this tab's) edit wins on the server
    await waitForServerText(page, s.title, "conflict base local");
    // and this tab's view converges on it, though the other device's echo
    // reached it while the batch was held
    await expect(page.locator(".block-text", { hasText: lost })).toHaveCount(0);
    await expect(page.locator(".block-text", { hasText: "conflict base local" }))
      .toBeVisible();
    // the other device's text is kept on today's note, under a header that
    // names the block's page and embeds the block
    const header = `[[conflict]] [[${s.title}]] — overwritten by ((${s.u1}))`;
    const entry = landing(await pageBlocks(page, s.today), header);
    expect(entry?.children.map((c) => c.text)).toEqual([lost]);

    // the feed brings the entry to this tab's journal
    await page.getByRole("link", { name: "Daily Notes" }).click();
    await expect(page.locator(".journal-day").first()).toContainText(lost);
  });
});

test("an edit to a block another device deleted lands on today's note as an orphan edit",
async ({ page }) => {
  test.setTimeout(60_000);
  await withScenario(page, "Orphan Landing", "skip base", async (s) => {
    const typed = "skip base local";
    const ack = await holdEditTo(page, s.u1, () =>
      s.remote("delete", [{ op: "delete", uid: s.u1 }]));

    await editBlock(page, "skip base", typed);
    await expect.poll(ack).not.toBeNull();
    expect(ack()!.skipped?.map(({ uid, op, reason }) => ({ uid, op, reason })))
      .toEqual([{ uid: s.u1, op: "update_text", reason: "block_not_found" }]);

    // the ghost leaves this tab's view of the page
    await expect(page.locator(".block-text", { hasText: typed })).toHaveCount(0);
    // the typed text is kept on today's note, under the orphan header
    const header =
      `[[conflict]] [[${s.title}]] — edit to a block the server no longer has`;
    await expect.poll(async () =>
      landing(await pageBlocks(page, s.today), header)?.children.map((c) => c.text),
    ).toEqual([typed]);

    await page.getByRole("link", { name: "Daily Notes" }).click();
    await expect(page.locator(".journal-day").first()).toContainText(typed);
  });
});
