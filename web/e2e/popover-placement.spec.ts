import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// pkm-muka: the block menu and the references popover are `position: fixed`
// and anchored at viewport coordinates read off the click. Rendering them
// inside a layout-contained ancestor makes that ancestor their containing
// block, so they paint displaced by its offset -- which is why `.journal-day`
// carries `content-visibility: auto` only now that both are portalled to
// `document.body`. A unit test can see the portal; only a real layout can see
// that the surface lands where the pointer was.

const PASSWORD = "e2e-pw";
// Enough rows per day that a lower day's top sits well above the viewport
// once we have scrolled into it -- that offset is the displacement under test.
const ROWS_PER_DAY = 45;
const PAST_DAYS = 3;

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November",
                "December"];

/** The daily-note title for a date, matching the server's `title_for_date`
 * (server/src/pkm/contracts/daily.py). */
function titleForDate(d: Date): string {
  const day = d.getDate();
  const suffix = day % 100 >= 10 && day % 100 <= 20
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th");
  return `${MONTHS[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

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

type Op = Record<string, unknown>;

async function postOps(page: Page, ops: Op[]) {
  const response = await page.request.post("/api/ops", { data: {
    client_id: "e2e-muka",
    batch_id: `e2e-muka-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ops,
  } });
  expect(response.ok()).toBeTruthy();
}

function rowOps(pageTitle: string, uidPrefix: string, count: number): Op[] {
  return Array.from({ length: count }, (_, i) => ({
    op: "create", uid: `${uidPrefix}${String(i).padStart(4, "0")}`,
    page_title: pageTitle, parent_uid: null, order_idx: i,
    text: `placement probe row ${i}`,
  }));
}

/** Where a click actually landed, and how far its `.journal-day` had
 * scrolled past the viewport top at that instant -- read from the event
 * itself, because `content-visibility` reflows the page as sections become
 * relevant, so anything measured before the click can be stale by the time
 * it happens. `dayTop` is exactly the displacement a missing portal adds. */
interface ClickProbe { x: number; y: number; dayTop: number }

async function recordClicks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __mukaClick?: unknown };
    w.__mukaClick = null;
    document.addEventListener("click", (e) => {
      const day = (e.target as Element).closest(".journal-day");
      w.__mukaClick = {
        x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY,
        dayTop: Math.round(day ? day.getBoundingClientRect().top : NaN),
      };
    }, true);
  });
}

async function lastClick(page: Page): Promise<ClickProbe> {
  const probe = await page.evaluate(() =>
    (window as unknown as { __mukaClick?: ClickProbe | null }).__mukaClick);
  expect(probe, "no click was recorded").not.toBeNull();
  return probe!;
}

test("the block menu opens at the pointer on a page", async ({ page }) => {
  const title = `MukaMenuPage${Date.now()}`;
  await login(page);
  await createPage(page, title);
  await postOps(page, rowOps(title, `mukapg${Date.now()}`.slice(0, 24), 8));

  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator(".block-row").first()).toBeVisible();
  const box = (await page.locator(".block-row .bullet").nth(3).boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.click(x, y);

  const menu = page.getByRole("menu", { name: "Block actions" });
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  expect(Math.abs(menuBox.x - x)).toBeLessThanOrEqual(2);
  expect(Math.abs(menuBox.y - y)).toBeLessThanOrEqual(2);
  await page.keyboard.press("Escape");
});

// One test for both surfaces: the seeded journal is the expensive part, and
// the menu and the popover fail the same way when they are not portalled.
test("menu and references popover stay anchored deep in a scrolled journal",
     async ({ page }) => {
  const stamp = Date.now();
  await login(page);
  // Past daily notes only: today's own day is never written, so this cannot
  // collide with edit.spec.ts's "today starts empty" assumption. Days 1..3
  // back are the newest non-empty days, so all three arrive in the journal's
  // first batch of five.
  const dayTitles: string[] = [];
  for (let back = 1; back <= PAST_DAYS; back++) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    const dayTitle = titleForDate(d);
    dayTitles.push(dayTitle);
    await createPage(page, dayTitle);
    await postOps(page,
      rowOps(dayTitle, `mk${back}${stamp}`.slice(0, 24), ROWS_PER_DAY));
  }
  // A reference into the LAST row of the oldest seeded day, so the badge
  // sits deep inside its section rather than near its top.
  const source = `MukaRefSrc${stamp}`;
  await createPage(page, source);
  const referenced =
    `${`mk${PAST_DAYS}${stamp}`.slice(0, 24)}${String(ROWS_PER_DAY - 1).padStart(4, "0")}`;
  await postOps(page, [{
    op: "create", uid: `mksrc${stamp}`.slice(0, 28),
    page_title: source, parent_uid: null, order_idx: 0,
    text: `see ((${referenced})) here`,
  }]);

  await page.goto("/");
  await expect.poll(async () => await page.locator(".journal-day").count(),
                    { timeout: 20_000 }).toBeGreaterThanOrEqual(PAST_DAYS);

  // --- the bullet menu, opened by a click deep inside a lower day ---
  await recordClicks(page);
  const lastDay = page.locator(".journal-day").last();
  await lastDay.locator(".block-row .bullet").nth(ROWS_PER_DAY - 6).click();
  const target = await lastClick(page);
  // The premise of the assertion below: without a portal the menu lands
  // `dayTop` px from the pointer, not within a couple of pixels of it.
  expect(target.dayTop).toBeLessThan(-400);

  const menu = page.getByRole("menu", { name: "Block actions" });
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  // Reported together: the failure mode displaces both axes (by the
  // section's own offset), and one number alone reads like a rounding bug.
  const off = { dx: Math.round(menuBox.x - target.x),
                dy: Math.round(menuBox.y - target.y) };
  const why = `menu displaced from the pointer by ${JSON.stringify(off)}`;
  expect(Math.abs(off.dx), why).toBeLessThanOrEqual(2);
  expect(Math.abs(off.dy), why).toBeLessThanOrEqual(2);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // --- the references popover, opened from a badge deep inside a day ---
  const badge = page.locator(".journal-day .block-ref-badge").first();
  await expect(badge).toHaveText("1");
  await badge.click();
  const badgeClick = await lastClick(page);
  // Same premise: the badge is far below its own section's top.
  expect(badgeClick.dayTop).toBeLessThan(-400);

  const popover = page.getByRole("dialog", { name: "References" });
  await expect(popover.getByText(source)).toBeVisible();
  const popBox = (await popover.boundingBox())!;
  const viewport = page.viewportSize()!;
  // Anchored under the badge and clamped into the viewport (pkm-7iv7). Under
  // a layout-contained ancestor the clamp still computes the same
  // coordinates; they just resolve against the section, not the viewport.
  expect(popBox.y).toBeGreaterThanOrEqual(0);
  expect(popBox.y + popBox.height).toBeLessThanOrEqual(viewport.height);
  expect(popBox.x).toBeGreaterThanOrEqual(0);
  expect(popBox.x + popBox.width).toBeLessThanOrEqual(viewport.width);
  // and, where the clamp did not have to move it, actually beside the badge
  expect(popBox.y).toBeGreaterThan(badgeClick.y - popBox.height - 24);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});
