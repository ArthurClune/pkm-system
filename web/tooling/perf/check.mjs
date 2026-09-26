// pattern: Imperative Shell
// Gated frontend perf check (spec: docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md).
// Headless, counts first. Run through perfcheck.run, which starts the fixture
// server on 8977 and sets PERF_FROZEN_NOW / PERF_FIXTURE_HASH / PERF_COMMIT.
// Every metric declares its class here; changing one is a reviewed change.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { BASE, BIG_PAGE, INIT, REACT_INIT, sleep, attachCounters, freshBag,
         login } from "./harness.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const OUT = arg("--out");
const ONLY = new Set((arg("--only", "H,W,A,B,F,J,I,K,S")).split(","));
const FROZEN = process.env.PERF_FROZEN_NOW;
if (!OUT || !FROZEN) { console.error("need --out and PERF_FROZEN_NOW"); process.exit(2); }
const IDLE_MS = 30_000;

const ex = (value) => ({ class: "exact", value });
const band = (value) => ({ class: "band", value });
const tm = (value) => ({ class: "timing", value: +value.toFixed(1) });
const scenarios = {};

// Runs before the fake clock is installed, so it keeps the real
// performance.now (sub-millisecond); the fake one counts whole milliseconds,
// too coarse for a drag handler.
const REAL_NOW = () => {
  const now = performance.now.bind(performance);
  window.__realNow = now;
};

// The fake clock replaces window.performance with a stub whose mark() is a
// no-op and whose getEntries*() return [], so the app's marks never reach
// the real timeline. Record them here (against the fake, flowing now()).
// The fake now() also keeps counting across navigations instead of
// restarting per document, so timings subtract this document's start.
const MARKS = () => {
  window.__docStart = performance.now();
  const marks = (window.__marks = []);
  const fake = performance.mark.bind(performance);
  performance.mark = (name, ...rest) => {
    marks.push({ name, startTime: performance.now() });
    return fake(name, ...rest);
  };
};

async function newContext(browser, { react = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 },
                                        timezoneId: "Europe/London" });
  await ctx.addInitScript(REAL_NOW);
  await ctx.clock.install({ time: new Date(FROZEN) });   // time flows from FROZEN
  await ctx.addInitScript(MARKS);
  await ctx.addInitScript(INIT);
  if (react) await ctx.addInitScript(REACT_INIT);
  return ctx;
}

// Playwright's "networkidle" is reached once per navigation and then stays
// reached, so after a page's first quiet spell it waits for nothing: the
// replica's pull after pkm:replica-ready, a journal fetch after the last
// scroll, a page fetch after an in-app click all raced the counters. settle()
// waits until none of the page's requests has been in flight for QUIET_MS,
// watching for at least that long itself: a request the app is about to
// send (the pull starts just after the mark) must not find it already done.
const QUIET_MS = 1000;
const SETTLE_TIMEOUT_MS = 30_000;

function trackInflight(page) {
  const net = { inflight: new Set(), lastChange: Date.now() };
  page.on("request", (r) => { net.inflight.add(r); net.lastChange = Date.now(); });
  const done = (r) => { net.inflight.delete(r); net.lastChange = Date.now(); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return net;
}

async function settle({ net }) {
  const start = Date.now(), deadline = start + SETTLE_TIMEOUT_MS;
  while (net.inflight.size > 0 || Date.now() - Math.max(net.lastChange, start) < QUIET_MS) {
    if (Date.now() > deadline) {
      const open = [...net.inflight].map((r) => r.url()).join(", ");
      throw new Error(`network did not settle within ${SETTLE_TIMEOUT_MS} ms; in flight: ${open || "none"}`);
    }
    await sleep(50);
  }
}

async function openPage(ctx) {
  const page = await ctx.newPage();
  const bag = freshBag();
  attachCounters(page, bag);
  const net = trackInflight(page);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  return { page, bag, cdp, net };
}

const layoutCount = async (cdp) =>
  (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "LayoutCount").value;

async function replicaReadyMs(page) {
  const ready = () => window.__marks.find((m) => m.name === "pkm:replica-ready");
  await page.waitForFunction(ready, null, { timeout: 120_000 });
  return page.evaluate(() => window.__marks.find((m) => m.name === "pkm:replica-ready")
    .startTime - window.__docStart);
}

// Resource entries come from a PerformanceObserver: the browser still
// records them, but the fake performance.getEntriesByType returns [].
// Called once the page has settled, so the buffered entries are complete.
const apiBytes = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no resource timing entries")), 10_000);
  new PerformanceObserver((list, obs) => {
    obs.disconnect();
    clearTimeout(timer);
    resolve(list.getEntries()
      .filter((r) => new URL(r.name).pathname.startsWith("/api/"))
      .reduce((s, r) => s + (r.encodedBodySize || 0), 0));
  }).observe({ type: "resource", buffered: true });
}));

const count = (bag, p) => bag.requests[p] ?? 0;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];
const suffix = (d) => (d % 100 >= 10 && d % 100 <= 20) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[d % 10] ?? "th");
const dailyTitle = (dt) => `${MONTHS[dt.getMonth()]} ${dt.getDate()}${suffix(dt.getDate())}, ${dt.getFullYear()}`;

const CLOCK_SLACK_MS = 10 * 60_000;

async function assertFrozenClock(page) {
  // The fake clock starts at FROZEN and flows, so the browser's now must sit
  // just after it; a real clock would read today's date.
  const seen = await page.evaluate(() => new Date().toISOString());
  const lag = Date.parse(seen) - Date.parse(FROZEN);
  if (!(lag >= 0 && lag < CLOCK_SLACK_MS)) {
    throw new Error(`browser clock not frozen: want just after ${FROZEN}, browser reads ${seen}`);
  }
}

async function assertNewestJournalDay(page) {
  // The journal opens on the newest existing day, whatever the clock says,
  // so this checks the fixture, not the clock: its newest day is FROZEN's.
  const want = dailyTitle(new Date(FROZEN));
  const first = await page.locator("section.journal-day").first().innerText();
  if (!first.includes(want)) {
    throw new Error(`fixture's newest journal day is not ${want}: first journal day reads ${JSON.stringify(first.slice(0, 40))}`);
  }
}

async function cold(st) {
  const { page, bag } = st;
  await login(page);
  const readyMs = await replicaReadyMs(page);
  await settle(st);
  await assertFrozenClock(page);
  await assertNewestJournalDay(page);
  scenarios["H/cold"] = {
    requests: ex(bag.requestTotal),
    api_bytes: ex(await apiBytes(page)),
    snapshot_requests: ex(count(bag, "/api/sync/snapshot")),
    changes_requests: ex(count(bag, "/api/sync/changes")),
    replica_ready_ms: tm(readyMs),
  };
}

async function warm(st) {
  const { page, bag } = st;
  for (const k of Object.keys(bag.requests)) delete bag.requests[k];
  bag.requestTotal = 0;
  await page.goto(BASE + BIG_PAGE);
  await page.waitForSelector("div.block-text", { timeout: 30_000 });
  const paintMs = await page.evaluate(() => performance.now() - window.__docStart);
  await settle(st);
  scenarios["W/warm"] = {
    requests: ex(bag.requestTotal),
    changes_requests: ex(count(bag, "/api/sync/changes")),
    snapshot_requests: ex(count(bag, "/api/sync/snapshot")),
    first_outline_ms: tm(paintMs),
  };
}

async function idle(st, name, url, readySel) {
  const { page } = st;
  await page.goto(BASE + url);
  await page.waitForSelector(readySel, { timeout: 30_000 });
  await settle(st);
  await page.evaluate(() => window.__perfReset());
  await sleep(IDLE_MS);
  const p = await page.evaluate(() => JSON.parse(JSON.stringify(window.__perf)));
  scenarios[name] = {
    timers_armed: band(p.st + p.si),
    fetches: band(p.fetch + p.xhr),
    ws_opens: ex(p.ws),
    long_tasks: band(p.longtasks),
  };
}

async function typeInto(st, rootSel, text, target) {
  const { page, cdp } = st;
  await target.click();
  await page.waitForSelector("textarea.block-input", { timeout: 10_000 });
  await page.locator("textarea.block-input").evaluate((el) =>
    el.setSelectionRange(el.value.length, el.value.length));
  await page.evaluate((sel) => { window.__perfReset(); window.__reactReset?.();
                                 window.__perfMutStart(sel); }, rootSel);
  const requests = [];
  const onRequest = (req) => requests.push(req);
  page.on("request", onRequest);
  const l0 = await layoutCount(cdp);
  // 120 ms per key keeps re-arming the 500 ms text debounce, so the typing
  // saves once (one POST /api/ops), 500 ms after the last key. The 2 s wait
  // is well clear of that; settle() then waits out the save's follow-ups.
  await page.keyboard.type(text, { delay: 120 });
  await sleep(2000);
  await settle(st);
  page.off("request", onRequest);
  const l1 = await layoutCount(cdp);
  const p = await page.evaluate(() => { window.__perfMutStop();
                                        return JSON.parse(JSON.stringify(window.__perf)); });
  const r = await page.evaluate(() => window.__react ? { ...window.__react } : null);
  await page.keyboard.press("Escape");
  return { layouts: l1 - l0, p, r, requests };
}

// /api requests, except a second pull of a sync window already pulled. That
// repeat is the replica's pending-changed retry: the save's WS seq nudge and
// its HTTP ack arrive together, and whichever the app handles first decides
// whether the pull saw the batch still pending (one pull or two, run to run).
// App scheduling, not typing cost; a new request of any kind still counts.
function apiRequests(requests) {
  const windows = new Set();
  let n = 0;
  for (const req of requests) {
    const u = new URL(req.url());
    if (!u.pathname.startsWith("/api/")) continue;
    if (u.pathname === "/api/sync/changes") {
      const since = u.searchParams.get("since");
      if (windows.has(since)) continue;
      windows.add(since);
    }
    n++;
  }
  return n;
}

const TYPED = "perf check typing probe, fifty characters exactly!".slice(0, 50);

async function typing(st) {
  const { page } = st;
  await page.goto(BASE + BIG_PAGE);
  await page.waitForSelector("div.block-text", { timeout: 30_000 });
  await settle(st);
  // nth(10): an ordinary text block, clear of the mermaid/katex/code blocks
  // the fixture puts at the top of the big page.
  const { layouts, p, requests } = await typeInto(st, ".outline, main, #root", TYPED,
                                                  page.locator("div.block-text").nth(10));
  scenarios["F/typing"] = { forced_layouts: band(layouts), mut_outside: ex(p.mutOutside),
                            api_requests: ex(apiRequests(requests)) };
}

async function journalScroll(st) {
  const { page, bag } = st;
  await page.goto(BASE + "/");
  await page.waitForSelector("section.journal-day", { timeout: 30_000 });
  await settle(st);
  for (const k of Object.keys(bag.requests)) delete bag.requests[k];
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 600); await sleep(250); }
  await settle(st);
  const pageFetches = Object.entries(bag.requests)
    .filter(([k]) => k.startsWith("/api/page/")).reduce((s, [, n]) => s + n, 0);
  scenarios["I/journal-scroll"] = {
    days_loaded: ex(await page.locator("section.journal-day").count()),
    journal_requests: ex(count(bag, "/api/journal")),
    page_requests: ex(pageFetches),
  };
}

async function journalTyping(st) {
  const { page } = st;
  await page.goto(BASE + "/");
  await page.waitForSelector("section.journal-day", { timeout: 30_000 });
  // Mount at least 30 days (a fixed target, so the count is repeatable).
  for (let i = 0; i < 60 && (await page.locator("section.journal-day").count()) < 30; i++) {
    await page.mouse.wheel(0, 6000); await sleep(500);
  }
  await settle(st);
  const days = await page.locator("section.journal-day").count();
  const { r } = await typeInto(st, ".journal, main, #root", TYPED,
                               page.locator("section.journal-day div.block-text").first());
  scenarios["J/journal-typing"] = { days_mounted: ex(days), react_commits: band(r.commits),
                                    rendered_fibers: band(r.rendered) };
}

async function drag(st, name, fromBottom) {
  const { page, cdp } = st;
  await page.goto(BASE + BIG_PAGE);
  await page.waitForSelector("div.block-text", { timeout: 30_000 });
  await settle(st);
  if (fromBottom) {
    await page.locator(".outline-drop-zone [data-uid]").last().scrollIntoViewIfNeeded();
    await sleep(1000);
  }
  await page.evaluate(() => window.__reactReset?.());
  const l0 = await layoutCount(cdp);
  const d = await page.evaluate(async ({ events, paceMs }) => {
    const zone = document.querySelector(".outline-drop-zone");
    const handle = zone?.querySelector('[data-uid] .bullet[draggable="true"]');
    if (!zone || !handle) return { error: "no drop zone / drag handle" };
    const transfer = new DataTransfer();
    const fire = (el, type, x, y) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y,
                                       dataTransfer: transfer });
      const t0 = window.__realNow(); el.dispatchEvent(ev);
      return { ms: window.__realNow() - t0, prevented: ev.defaultPrevented };
    };
    fire(handle, "dragstart", 40, 120);
    await new Promise((r) => setTimeout(r, 100));
    const top = 80, bottom = window.innerHeight - 40, ms = [];
    let notPrevented = 0;
    for (let i = 0; i < events; i++) {
      const got = fire(zone, "dragover", 200, top + ((bottom - top) * i) / (events - 1));
      ms.push(got.ms); if (!got.prevented) notPrevented++;
      await new Promise((r) => setTimeout(r, paceMs));
    }
    fire(handle, "dragend", 200, bottom);
    return { totalMs: ms.reduce((s, v) => s + v, 0), notPrevented };
  }, { events: 120, paceMs: 16 });
  if (d.error) throw new Error(d.error);
  await sleep(1500);
  const r = await page.evaluate(() => ({ ...window.__react }));
  scenarios[name] = { not_prevented: ex(d.notPrevented), react_commits: band(r.commits),
                      forced_layouts: band((await layoutCount(cdp)) - l0),
                      // summed over the 120 dragovers: one handler takes
                      // ~0.2 ms, too close to the clock's resolution alone
                      handler_ms: tm(d.totalMs) };
}

async function search(st, name, term) {
  const { page, bag } = st;
  await page.goto(BASE + "/");
  await page.waitForSelector("section.journal-day", { timeout: 30_000 });
  await settle(st);
  const input = page.locator("input.top-bar-search-input");
  await input.click();
  for (const k of Object.keys(bag.requests)) delete bag.requests[k];
  await page.evaluate(() => { window.__perfReset(); window.__reactReset?.(); });
  // Type all but the last key and let its results land, then time the last
  // key in the page: keydown to the render of that term's results. The
  // `Create page "<term>"` row appears once results for exactly the typed
  // term are on screen (no fixture page carries either term as its title).
  const head = term.slice(0, -1), last = term.slice(-1);
  const created = (q) => `li.search-result:has-text('Create page "${q}"')`;
  await input.pressSequentially(head, { delay: 150 });
  await page.waitForSelector(created(head), { timeout: 15_000 });
  await settle(st);
  await page.evaluate((label) => {
    const input = document.querySelector("input.top-bar-search-input");
    window.__searchMs = new Promise((resolve) => {
      let t0 = null;
      const done = () => [...document.querySelectorAll("li.search-result .result-page")]
        .some((el) => el.textContent === label);
      const mo = new MutationObserver(() => {
        if (t0 !== null && done()) { mo.disconnect(); resolve(performance.now() - t0); }
      });
      mo.observe(document.body, { subtree: true, childList: true, characterData: true });
      input.addEventListener("keydown", () => { t0 = performance.now(); },
                             { once: true, capture: true });
    });
  }, `Create page "${term}"`);
  await input.press(last);
  const resultsMs = await page.evaluate(() => Promise.race([
    window.__searchMs,
    new Promise((_, reject) => setTimeout(() => reject(new Error("no results for the full term")), 15_000)),
  ]));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  // Open a real block hit by clicking it: Enter on the synthetic
  // `Create page "…"` row would write to the DB mid-run.
  await page.locator("li.search-result:has(mark)").first().click();
  await settle(st);
  const p = await page.evaluate(() => JSON.parse(JSON.stringify(window.__perf)));
  const r = await page.evaluate(() => ({ ...window.__react }));
  scenarios[name] = {
    search_requests: ex(count(bag, "/api/search")),
    fetches: ex(p.fetch + p.xhr),
    react_commits: band(r.commits),
    results_ms: tm(resultsMs),
  };
}

const any = (...ids) => ids.some((id) => ONLY.has(id));

// Every failure names what it was doing, so a broken gate says which
// scenario to look at.
async function step(label, fn) {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${label} failed: ${e.message}`, { cause: e });
  }
}
const run = (name, fn) => step(`scenario ${name}`, fn);

async function loggedIn(browser, letters, opts) {
  return step(`setup for ${letters}`, async () => {
    const ctx = await newContext(browser, opts);
    const st = await openPage(ctx);
    await login(st.page);
    await replicaReadyMs(st.page);
    await assertFrozenClock(st.page);
    return { ctx, st };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    // H and W share a fresh context: H is its first (empty-replica) load,
    // W the next navigation once replica and service worker are warm.
    if (any("H", "W")) {
      const ctx = await newContext(browser);
      const st = await openPage(ctx);
      await run("H/cold", () => cold(st));
      if (ONLY.has("W")) await run("W/warm", () => warm(st));
      if (!ONLY.has("H")) delete scenarios["H/cold"];
      await ctx.close();
    }
    // No React hook here: it walks the fiber tree on every commit and would
    // distort idle and typing behaviour.
    if (any("A", "B", "F", "I")) {
      const { ctx, st } = await loggedIn(browser, "A,B,F,I");
      if (ONLY.has("A")) await run("A/idle-big", () =>
        idle(st, "A/idle-big", BIG_PAGE, "div.block-text"));
      if (ONLY.has("B")) await run("B/idle-journal", () =>
        idle(st, "B/idle-journal", "/", "section.journal-day"));
      if (ONLY.has("F")) await run("F/typing", () => typing(st));
      if (ONLY.has("I")) await run("I/journal-scroll", () => journalScroll(st));
      await ctx.close();
    }
    // React-hook context for commit counts (J, K, S).
    if (any("J", "K", "S")) {
      const { ctx, st } = await loggedIn(browser, "J,K,S", { react: true });
      if (ONLY.has("J")) await run("J/journal-typing", () => journalTyping(st));
      if (ONLY.has("K")) {
        await run("K/drag-top", () => drag(st, "K/drag-top", false));
        await run("K/drag-bottom", () => drag(st, "K/drag-bottom", true));
      }
      if (ONLY.has("S")) {
        await run("S/search-common", () => search(st, "S/search-common", "project"));
        await run("S/search-rare", () => search(st, "S/search-rare", "zyxquark"));
      }
      await ctx.close();
    }
    const doc = { commit: process.env.PERF_COMMIT ?? "working-tree",
                  fixture_hash: process.env.PERF_FIXTURE_HASH ?? "unknown",
                  env: { chromium: browser.version(), node: process.version }, scenarios };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT + ".tmp", JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(OUT + ".tmp", OUT);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
