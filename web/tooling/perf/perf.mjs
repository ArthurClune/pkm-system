// Runtime performance / energy measurement of the PKM SPA.
// Usage (see README.md): node perf.mjs [scenarioLetters]
//   A idle big page   B idle journal   E degraded link   E2 degraded + edit
//   F typing   G two tabs   H cold load   I journal scroll
//   J journal with every seeded day mounted: React commits and re-rendered
//     fibers per keystroke. Off by default because its DevTools hook walks
//     the fiber tree on every commit, which would inflate every other
//     scenario's CPU.
//   C (tab hidden) and D (setOffline) are kept for reference but are OFF by
//   default: neither measures what it claims (README "caveats").
// Requires: seeded throwaway server on E2E_PORT (default 8977).
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const PORT = process.env.E2E_PORT ?? "8977";
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "e2e-pw";
const BIG_PAGE = "/page/" + encodeURIComponent("Perf Big Page");
const INIT = fs.readFileSync(path.join(HERE, "instrument.js"), "utf8");
const REACT_INIT = fs.readFileSync(path.join(HERE, "react-commits.js"), "utf8");
const DUR = Number(process.env.DUR ?? 60_000);
const HEADLESS = process.env.HEADLESS === "1";
const ONLY = (process.argv[2] ?? "ABEFGHI").toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

// ---------------------------------------------------------------- CPU time
// macOS `ps -o time` reports cumulative CPU time with hundredths, so a delta
// over a scenario divided by wall time is a true average core utilisation --
// unlike %cpu, which is a decaying lifetime average.
function cpuSnapshot() {
  const out = execSync("ps -Ao pid=,ppid=,time=,rss=").toString();
  const procs = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)$/);
    if (!m) continue;
    const [, pid, ppid, t, rss] = m;
    const parts = t.split(":");
    let secs = 0;
    if (parts.length === 3) secs = +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
    else secs = +parts[0] * 60 + parseFloat(parts[1]);
    procs.set(+pid, { ppid: +ppid, cpu: secs, rss: +rss });
  }
  return procs;
}
function treeCpu(snap, rootPid) {
  const kids = new Map();
  for (const [pid, p] of snap) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(pid);
  }
  let cpu = 0, rss = 0, n = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = snap.get(pid);
    if (!p) continue;
    cpu += p.cpu; rss += p.rss; n++;
    for (const k of kids.get(pid) ?? []) stack.push(k);
  }
  return { cpu, rssMB: rss / 1024, procs: n };
}
// Playwright's Browser has no .process(), and on macOS the Chromium helper
// (renderer/GPU) processes are NOT descendants of the pid that matches the
// browser binary -- a pid-tree walk finds one 9 MB process. So: enumerate
// every ms-playwright process, and subtract the set that existed before
// launch. Renderers, GPU and utility processes all appear afterwards.
function chromiumPids() {
  const out = execSync("ps -Ao pid=,command= || true").toString();
  const pids = new Set();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    if (!/ms-playwright/i.test(m[2])) continue;
    pids.add(+m[1]);
  }
  return pids;
}
let PW_BASELINE = new Set();
function browserCpuDelta(snap0, snap1, wall) {
  let cpu = 0, rss = 0, n = 0;
  for (const pid of chromiumPids()) {
    if (PW_BASELINE.has(pid)) continue;
    const a = snap0.get(pid), b = snap1.get(pid);
    if (!b) continue;
    cpu += Math.max(0, b.cpu - (a ? a.cpu : b.cpu));
    rss += b.rss; n++;
  }
  return { pct: (cpu / wall) * 100, rssMB: rss / 1024, procs: n };
}

function serverPid() {
  try {
    return +execSync("pgrep -f 'tests/e2e_serve.py' | head -1").toString().trim();
  } catch { return null; }
}

// ------------------------------------------------------------ CDP metrics
async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = {};
  for (const { name, value } of metrics) m[name] = value;
  return m;
}
const METRIC_KEYS = ["TaskDuration", "ScriptDuration", "LayoutDuration",
                     "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount",
                     "JSHeapUsedSize", "Nodes", "JSEventListeners"];

// --------------------------------------------------------------- recorder
function attachCounters(page, bag) {
  page.on("request", (req) => {
    const u = req.url();
    let k;
    try { k = new URL(u).pathname; } catch { k = u; }
    bag.requests[k] = (bag.requests[k] || 0) + 1;
    bag.requestTotal++;
  });
  page.on("websocket", (ws) => {
    bag.wsOpened++;
    ws.on("framesent", () => bag.wsSent++);
    ws.on("framereceived", () => bag.wsRecv++);
    ws.on("close", () => bag.wsClosed++);
  });
}
const freshBag = () => ({ requests: {}, requestTotal: 0, wsOpened: 0,
                          wsSent: 0, wsRecv: 0, wsClosed: 0 });
function resetBag(bag) {
  bag.requests = {}; bag.requestTotal = 0;
  bag.wsOpened = 0; bag.wsSent = 0; bag.wsRecv = 0; bag.wsClosed = 0;
}

async function measure(name, pages, cdps, bags, durationMs, opts = {}) {
  const browserPid = opts.browserPid, srvPid = opts.serverPid;
  for (const p of pages) await p.evaluate(() => {
    window.__perfReset();
    if (window.__reactReset) window.__reactReset();
  });
  for (const b of bags) resetBag(b);
  const before = [];
  for (const c of cdps) before.push(await cdpMetrics(c));
  const snap0 = cpuSnapshot();
  const t0 = Date.now();
  const vis0 = await pages[0].evaluate(() => document.visibilityState);

  if (opts.during) await opts.during();
  const remaining = durationMs - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);

  const wall = (Date.now() - t0) / 1000;
  const snap1 = cpuSnapshot();
  const after = [];
  for (const c of cdps) after.push(await cdpMetrics(c));
  const vis1 = await pages[0].evaluate(() => document.visibilityState);
  const perf = [];
  for (const p of pages) perf.push(await p.evaluate(() => JSON.parse(JSON.stringify(window.__perf))));
  // null unless the React commit hook was installed (scenario J only).
  const react = [];
  for (const p of pages) react.push(await p.evaluate(() =>
    window.__react ? JSON.parse(JSON.stringify(window.__react)) : null));

  const cdpDelta = [];
  for (let i = 0; i < before.length; i++) {
    const d = {};
    for (const k of METRIC_KEYS) {
      d[k] = k === "JSHeapUsedSize" || k === "Nodes" || k === "JSEventListeners"
        ? after[i][k] : (after[i][k] ?? 0) - (before[i][k] ?? 0);
    }
    cdpDelta.push(d);
  }
  const b1 = browserCpuDelta(snap0, snap1, wall);
  const browserCpuPct = b1.pct;
  let serverCpuPct = null;
  if (srvPid) {
    const s0 = treeCpu(snap0, srvPid), s1 = treeCpu(snap1, srvPid);
    serverCpuPct = ((s1.cpu - s0.cpu) / wall) * 100;
  }
  const r = { name, wallSec: +wall.toFixed(1), visibility: [vis0, vis1],
              perf, react, bags: bags.map((b) => JSON.parse(JSON.stringify(b))),
              cdp: cdpDelta,
              browserCpuPct: +browserCpuPct.toFixed(1),
              browserRssMB: +b1.rssMB.toFixed(0), browserProcs: b1.procs,
              serverCpuPct: serverCpuPct === null ? null : +serverCpuPct.toFixed(2),
              ...(opts.extra ?? {}) };
  results[name] = r;
  const p = perf[0], bg = bags[0];
  console.log(`\n[${name}] ${wall.toFixed(1)}s vis=${vis0}/${vis1} ` +
    `cpu=${browserCpuPct.toFixed(1)}% srv=${serverCpuPct?.toFixed(2) ?? "-"}% ` +
    `task=${cdpDelta[0].TaskDuration.toFixed(2)}s script=${cdpDelta[0].ScriptDuration.toFixed(2)}s ` +
    `| timers st=${p.st}/${p.stFired} si=${p.si}/${p.siFired} raf=${p.raf}/${p.rafFired} ` +
    `fetch=${p.fetch} ws=${p.ws} lt=${p.longtasks}(${p.longtaskMs.toFixed(0)}ms) ` +
    `| net req=${bg.requestTotal} wsOpen=${bg.wsOpened} sent=${bg.wsSent} recv=${bg.wsRecv}`);
  if (react[0]) console.log(`   react: commits=${react[0].commits} ` +
    `renderedFibers=${react[0].rendered} maxInOneCommit=${react[0].maxRendered} ` +
    `fibersVisited=${react[0].visited}`);
  if (Object.keys(p.fetchUrls).length) console.log("   fetchUrls:", JSON.stringify(p.fetchUrls));
  if (bg.requestTotal) console.log("   requests:", JSON.stringify(bg.requests));
  return r;
}

async function login(page) {
  await page.goto(BASE + "/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
}

// ------------------------------------------------------------------- main
async function main() {
  PW_BASELINE = chromiumPids();
  const browser = await chromium.launch({ headless: HEADLESS });
  await sleep(500);
  const browserPid = [...chromiumPids()].filter((p) => !PW_BASELINE.has(p))[0] ?? null;
  const srvPid = serverPid();
  console.log(`browser pid=${browserPid} headless=${HEADLESS} server pid=${srvPid} dur=${DUR}ms`);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(INIT);
  if (ONLY.includes("J")) await context.addInitScript(REACT_INIT);
  const page = await context.newPage();
  const bag = freshBag();
  attachCounters(page, bag);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  await login(page);
  await page.waitForSelector(".journal-day", { timeout: 30_000 });
  await sleep(8000); // let the replica finish its initial sync

  const opts = { browserPid, serverPid: srvPid };
  const one = (n, o) => measure(n, [page], [cdp], [bag], DUR, { ...opts, ...o });

  // ---- H. cold load (done early, on a pristine profile-warm page) --------
  if (ONLY.includes("H")) {
    const cold = await context.newPage();
    const coldBag = freshBag();
    attachCounters(cold, coldBag);
    const coldCdp = await context.newCDPSession(cold);
    await coldCdp.send("Performance.enable");
    const t0 = Date.now();
    await cold.goto(BASE + BIG_PAGE, { waitUntil: "load" });
    const loadMs = Date.now() - t0;
    await cold.waitForSelector(".block-text", { timeout: 30_000 });
    const firstBlockMs = Date.now() - t0;
    await sleep(4000);
    const nav = await cold.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0] ?? {};
      const res = performance.getEntriesByType("resource");
      const js = res.filter((r) => /\.js(\?|$)/.test(r.name));
      const css = res.filter((r) => /\.css(\?|$)/.test(r.name));
      const wasm = res.filter((r) => /\.wasm(\?|$)/.test(r.name));
      const sum = (a, f) => a.reduce((s, r) => s + (r[f] || 0), 0);
      return {
        domContentLoadedMs: Math.round(n.domContentLoadedEventEnd ?? 0),
        loadEventMs: Math.round(n.loadEventEnd ?? 0),
        jsChunks: js.length, jsTransferKB: Math.round(sum(js, "transferSize") / 1024),
        jsDecodedKB: Math.round(sum(js, "decodedBodySize") / 1024),
        cssFiles: css.length, cssTransferKB: Math.round(sum(css, "transferSize") / 1024),
        wasmFiles: wasm.length, wasmTransferKB: Math.round(sum(wasm, "transferSize") / 1024),
        totalResources: res.length,
        totalTransferKB: Math.round(sum(res, "transferSize") / 1024),
        longtasks: window.__perf.longtasks,
        longtaskMs: Math.round(window.__perf.longtaskMs),
        maxLongtaskMs: Math.round(window.__perf.maxLongtask),
        timersScheduled: window.__perf.st + window.__perf.si,
        rafScheduled: window.__perf.raf,
      };
    });
    const m = await cdpMetrics(coldCdp);
    results.H = { name: "H cold load", loadMs, firstBlockMs, ...nav,
                  jsHeapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1),
                  nodes: m.Nodes, taskDurationS: +m.TaskDuration.toFixed(2),
                  scriptDurationS: +m.ScriptDuration.toFixed(2),
                  requests: coldBag.requests, requestTotal: coldBag.requestTotal };
    console.log("\n[H cold load]", JSON.stringify(results.H, null, 1));
    await cold.close();

    // H2: genuinely cold -- a fresh context with the service worker blocked,
    // so transferSize reflects the network rather than the SW precache.
    const ctx2 = await browser.newContext({ serviceWorkers: "block",
                                            viewport: { width: 1440, height: 900 } });
    await ctx2.addInitScript(INIT);
    const p2 = await ctx2.newPage();
    const bag2 = freshBag();
    attachCounters(p2, bag2);
    const cdp2 = await ctx2.newCDPSession(p2);
    await cdp2.send("Performance.enable");
    await login(p2);
    const t2 = Date.now();
    await p2.goto(BASE + BIG_PAGE, { waitUntil: "load" });
    const loadMs2 = Date.now() - t2;
    await p2.waitForSelector(".block-text", { timeout: 30_000 });
    const firstBlockMs2 = Date.now() - t2;
    await sleep(5000);
    const nav2 = await p2.evaluate(() => {
      const res = performance.getEntriesByType("resource");
      const sum = (a, f) => a.reduce((s, r) => s + (r[f] || 0), 0);
      const js = res.filter((r) => /\.js(\?|$)/.test(r.name));
      const wasm = res.filter((r) => /\.wasm(\?|$)/.test(r.name));
      return { jsChunks: js.length,
               jsTransferKB: Math.round(sum(js, "transferSize") / 1024),
               jsDecodedKB: Math.round(sum(js, "decodedBodySize") / 1024),
               wasmTransferKB: Math.round(sum(wasm, "transferSize") / 1024),
               wasmDecodedKB: Math.round(sum(wasm, "decodedBodySize") / 1024),
               totalTransferKB: Math.round(sum(res, "transferSize") / 1024),
               totalResources: res.length,
               longtasks: window.__perf.longtasks,
               longtaskMs: Math.round(window.__perf.longtaskMs),
               maxLongtaskMs: Math.round(window.__perf.maxLongtask) };
    });
    const m2 = await cdpMetrics(cdp2);
    results.H2 = { name: "H2 cold load (SW blocked)", loadMs: loadMs2,
                   firstBlockMs: firstBlockMs2, ...nav2,
                   jsHeapMB: +(m2.JSHeapUsedSize / 1048576).toFixed(1),
                   nodes: m2.Nodes, taskDurationS: +m2.TaskDuration.toFixed(2),
                   scriptDurationS: +m2.ScriptDuration.toFixed(2),
                   layoutDurationS: +m2.LayoutDuration.toFixed(2),
                   recalcStyleDurationS: +m2.RecalcStyleDuration.toFixed(2),
                   requestTotal: bag2.requestTotal };
    console.log("\n[H2 cold load SW-blocked]", JSON.stringify(results.H2, null, 1));
    await ctx2.close();
  }

  // ---- A. idle, online, foreground, big page ----------------------------
  await page.goto(BASE + BIG_PAGE);
  await page.waitForSelector(".block-text", { timeout: 30_000 });
  await sleep(5000);
  const workers = page.workers().map((w) => w.url());
  console.log("page workers:", JSON.stringify(workers));
  results.workers = workers;
  if (ONLY.includes("A")) await one("A idle big page");

  // ---- B. idle, online, /journal ----------------------------------------
  if (ONLY.includes("B")) {
    await page.goto(BASE + "/");
    await page.waitForSelector(".journal-day", { timeout: 30_000 });
    await sleep(5000);
    await one("B idle journal");
  }

  // ---- C. idle, online, tab hidden --------------------------------------
  if (ONLY.includes("C")) {
    await page.goto(BASE + BIG_PAGE);
    await page.waitForSelector(".block-text", { timeout: 30_000 });
    await sleep(3000);
    const stealer = await context.newPage();
    await stealer.goto("about:blank");
    await stealer.bringToFront();
    await sleep(1000);
    await one("C idle hidden");
    await stealer.close();
    await page.bringToFront();
    await sleep(1000);
  }

  // ---- F. typing --------------------------------------------------------
  if (ONLY.includes("F")) {
    await page.goto(BASE + BIG_PAGE);
    await page.waitForSelector(".block-text", { timeout: 30_000 });
    await sleep(3000);
    await page.locator(".block-text").first().click();
    await page.waitForSelector("textarea.block-input", { timeout: 10_000 });
    await page.locator("textarea.block-input").evaluate((el) =>
      el.setSelectionRange(el.value.length, el.value.length));
    await page.evaluate(() => window.__perfMutStart(".outline, main, #root"));
    const TEXT = "the quick brown fox jumps over the lazy dog while sync retries. ".repeat(4).slice(0, 200);
    await measure("F typing 200ch", [page], [cdp], [bag], 0, {
      ...opts,
      during: async () => { await page.keyboard.type(TEXT, { delay: 60 }); await sleep(1500); },
      extra: { chars: TEXT.length },
    });
    await page.evaluate(() => window.__perfMutStop());
    await page.keyboard.press("Escape");
    await sleep(2000);
  }

  // ---- G. multi-tab fan-out --------------------------------------------
  if (ONLY.includes("G")) {
    const tab2 = await context.newPage();
    const bag2 = freshBag();
    attachCounters(tab2, bag2);
    const cdp2 = await context.newCDPSession(tab2);
    await cdp2.send("Performance.enable");
    await tab2.goto(BASE + BIG_PAGE);
    await tab2.waitForSelector(".block-text", { timeout: 30_000 });
    await sleep(4000);
    await page.bringToFront();
    await page.locator(".block-text").first().click();
    await page.waitForSelector("textarea.block-input", { timeout: 10_000 });
    await page.locator("textarea.block-input").evaluate((el) =>
      el.setSelectionRange(el.value.length, el.value.length));
    await measure("G multitab type50", [page, tab2], [cdp, cdp2], [bag, bag2], 0, {
      ...opts,
      during: async () => {
        await page.keyboard.type("multitab fan-out probe: fifty characters typed ok", { delay: 60 });
        await sleep(4000);
      },
    });
    await page.keyboard.press("Escape");
    await tab2.close();
    await sleep(2000);
  }

  // ---- I. journal scroll -------------------------------------------------
  if (ONLY.includes("I")) {
    await page.goto(BASE + "/");
    await page.waitForSelector(".journal-day", { timeout: 30_000 });
    await sleep(4000);
    await measure("I journal scroll", [page], [cdp], [bag], 0, {
      ...opts,
      during: async () => {
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, 600);
          await sleep(250);
        }
        await sleep(2000);
      },
    });
  }

  // ---- J. journal churn: React commits / re-rendered fibers per keystroke -
  // The Journal mounts one EditablePage per loaded day and never unmounts it,
  // so this is the scenario where a single new Sync context identity costs
  // every mounted outline a re-render (pkm-qfee).
  if (ONLY.includes("J")) {
    await page.goto(BASE + "/");
    await page.waitForSelector(".journal-day", { timeout: 30_000 });
    // Scroll to the bottom until the seeded days stop arriving: the journal
    // loads a window at a time off an IntersectionObserver sentinel.
    let days = 0;
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 6000);
      await sleep(500);
      const n = await page.locator(".journal-day").count();
      if (n === days && i > 2) break;
      days = n;
    }
    await sleep(3000);
    const dayCount = await page.locator(".journal-day").count();
    const rowCount = await page.locator(".journal-day .block-row").count();
    await page.locator(".journal-day .block-text").first().click();
    await page.waitForSelector("textarea.block-input", { timeout: 10_000 });
    await page.locator("textarea.block-input").evaluate((el) =>
      el.setSelectionRange(el.value.length, el.value.length));
    await page.evaluate(() => window.__perfMutStart(".journal, main, #root"));
    const TEXT = "journal churn probe: fifty characters typed ok now".slice(0, 50);
    const r = await measure("J journal all-days type50", [page], [cdp], [bag], 0, {
      ...opts,
      during: async () => {
        await page.keyboard.type(TEXT, { delay: 60 });
        await sleep(3000); // the 500 ms text debounce plus its round trip
      },
      extra: { days: dayCount, blockRows: rowCount, chars: TEXT.length },
    });
    await page.evaluate(() => window.__perfMutStop());
    const rk = r.react[0];
    if (rk) {
      r.perKeystroke = {
        commits: +(rk.commits / TEXT.length).toFixed(2),
        renderedFibers: +(rk.rendered / TEXT.length).toFixed(1),
        fibersVisited: +(rk.visited / TEXT.length).toFixed(1),
        maxRenderedInOneCommit: rk.maxRendered,
      };
      console.log(`   J: ${dayCount} days / ${rowCount} block rows — ` +
        `${r.perKeystroke.commits} commits and ` +
        `${r.perKeystroke.renderedFibers} re-rendered fibers per keystroke ` +
        `(worst single commit ${rk.maxRendered})`);
    } else {
      console.log("   J: no React commit hook — was J passed as a scenario letter?");
    }
    await page.keyboard.press("Escape");
    await sleep(2000);
  }

  // ---- D. offline -------------------------------------------------------
  if (ONLY.includes("D")) {
    await page.goto(BASE + BIG_PAGE);
    await page.waitForSelector(".block-text", { timeout: 30_000 });
    await sleep(4000);
    await context.setOffline(true);
    await sleep(2000);
    await one("D offline idle");
    // D2: offline WITH the tab hidden -- does backgrounding calm the churn?
    if (ONLY.includes("C")) {
      const stealer = await context.newPage();
      await stealer.goto("about:blank");
      await stealer.bringToFront();
      await sleep(1000);
      await one("D2 offline hidden");
      await stealer.close();
      await page.bringToFront();
    }
    await context.setOffline(false);
    await sleep(6000);
  }

  // ---- E. degraded: slow-failing HTTP + refused WS ----------------------
  if (ONLY.includes("E")) {
    await page.route("**/api/sync/changes*", async (route) => {
      await sleep(8000);
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/ops*", async (route) => {
      await sleep(8000);
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    try {
      await page.routeWebSocket("**/api/ws", (ws) => { ws.close(); });
    } catch (e) { console.log("routeWebSocket unavailable:", e.message); }
    await page.goto(BASE + BIG_PAGE);
    await page.waitForSelector(".block-text", { timeout: 30_000 }).catch(() => {});
    await sleep(3000);
    await one("E degraded idle");
    // E2: degraded WITH an edit pending, so the op queue is actively retrying
    await page.locator(".block-text").first().click().catch(() => {});
    await page.waitForSelector("textarea.block-input", { timeout: 10_000 }).catch(() => {});
    await page.keyboard.type(" degraded edit", { delay: 40 }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(1000);
    await one("E2 degraded pending edit");
    await page.unrouteAll();
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log("\nwrote results.json");
  await browser.close();
}

main().catch(async (e) => { console.error(e); process.exit(1); });
