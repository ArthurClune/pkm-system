// Attribute the offline-scenario CPU: which Chromium process burns it, and
// does the app's socket actually notice it is offline?
// Run: cd scratchpad && node offline-probe.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? "8977"}`;
const INIT = fs.readFileSync(path.join(HERE, "instrument.js"), "utf8");
const BIG = "/page/" + encodeURIComponent("Perf Big Page");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = Number(process.env.WIN ?? 25_000);

function snap() {
  const out = execSync("ps -Ao pid=,time=,rss=,command=").toString();
  const m = new Map();
  for (const line of out.split("\n")) {
    const mm = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!mm) continue;
    const parts = mm[2].split(":");
    const secs = parts.length === 3
      ? +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2])
      : +parts[0] * 60 + parseFloat(parts[1]);
    m.set(+mm[1], { cpu: secs, rss: +mm[3], cmd: mm[4] });
  }
  return m;
}
function label(cmd) {
  const t = cmd.match(/--type=(\S+)/);
  const u = cmd.match(/--utility-sub-type=(\S+)/);
  if (/e2e_serve/.test(cmd)) return "uvicorn server";
  if (!/ms-playwright/.test(cmd)) return null;
  if (!t) return "chromium browser process";
  return `chromium ${t[1]}${u ? " " + u[1].split(".").pop() : ""}`;
}

async function window_(name, page, ms, before) {
  const s0 = snap();
  await page.evaluate(() => window.__perfReset());
  const t0 = Date.now();
  if (before) await before();
  const rest = ms - (Date.now() - t0);
  if (rest > 0) await sleep(rest);
  const wall = (Date.now() - t0) / 1000;
  const s1 = snap();
  const rows = [];
  for (const [pid, b] of s1) {
    const l = label(b.cmd);
    if (!l) continue;
    const a = s0.get(pid);
    const d = a ? b.cpu - a.cpu : 0;
    if (d <= 0.02) continue;
    rows.push({ pid, label: l, pct: +((d / wall) * 100).toFixed(1),
                rssMB: Math.round(b.rss / 1024) });
  }
  rows.sort((x, y) => y.pct - x.pct);
  const p = await page.evaluate(() => ({ ...window.__perf }));
  const status = await page.evaluate(() => ({
    online: navigator.onLine,
    banner: !!document.querySelector(".ws-banner"),
    bannerText: document.querySelector(".ws-banner")?.textContent ?? null,
    visibility: document.visibilityState,
  }));
  console.log(`\n== ${name} (${wall.toFixed(0)}s) ==`);
  console.log("  app:", JSON.stringify(status));
  console.log("  page counters:", JSON.stringify({ st: p.st, stFired: p.stFired,
    si: p.si, siFired: p.siFired, fetch: p.fetch, ws: p.ws,
    longtasks: p.longtasks, longtaskMs: Math.round(p.longtaskMs) }));
  console.log("  cpu by process:");
  for (const r of rows) console.log(`    ${String(r.pct).padStart(6)}%  ${r.label}  (pid ${r.pid}, rss ${r.rssMB}MB)`);
  if (!rows.length) console.log("    (nothing above 0.02s)");
  return { name, rows, page: p, status };
}

const main = async () => {
  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  let wsOpens = 0;
  page.on("websocket", (ws) => { wsOpens++; ws.on("close", () => console.log("   [ws closed]")); });
  await page.goto(BASE + "/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await page.goto(BASE + BIG);
  await page.waitForSelector(".block-text", { timeout: 30_000 });
  await sleep(6000);

  // sanity: does the longtask observer actually fire?
  await page.evaluate(() => { const t = Date.now(); while (Date.now() - t < 300); });
  await sleep(500);
  const lt = await page.evaluate(() => window.__perf.longtasks);
  console.log(`longtask observer sanity: ${lt} entries after a synthetic 300ms block`);

  const out = [];
  out.push(await window_("1. online idle", page, WIN));
  out.push(await window_("2. OFFLINE idle", page, WIN, async () => {
    await ctx.setOffline(true); await sleep(1500);
  }));
  const stealer = await ctx.newPage();
  await stealer.goto("about:blank");
  await stealer.bringToFront();
  out.push(await window_("3. OFFLINE + other tab focused", page, WIN));
  await stealer.close();
  await page.bringToFront();
  out.push(await window_("4. back ONLINE idle", page, WIN, async () => {
    await ctx.setOffline(false); await sleep(1500);
  }));
  // 5: a real dead server rather than Chromium's offline emulation --
  // route every request to an abort, and refuse the ws upgrade.
  await page.routeWebSocket("**/api/ws", (ws) => ws.close());
  await page.route("**/api/**", (r) => r.abort("connectionrefused"));
  await page.reload().catch(() => {});
  await sleep(3000);
  out.push(await window_("5. server refusing (real conn errors)", page, WIN));
  console.log(`\ntotal page-level WebSocket opens seen by playwright: ${wsOpens}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "offline-probe.json"), JSON.stringify(out, null, 2));
  await browser.close();
};
main().catch((e) => { console.error(e); process.exit(1); });
