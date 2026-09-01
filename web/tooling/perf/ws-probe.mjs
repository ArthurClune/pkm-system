// Answers: under a degraded link, how many `new WebSocket` constructions per
// minute, and does a reconnect that SUCCEEDS trigger GET /api/sync/changes?
//
// The main run's in-page WebSocket counter reads 0 under page.routeWebSocket,
// because Playwright installs its own window.WebSocket mock AFTER our init
// script. Counting the route handler's invocations measures the same thing
// directly: one invocation per connection attempt the page makes.
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
const WIN = Number(process.env.WIN ?? 60_000);

function cpuNow() {
  const out = execSync("ps -Ao pid=,time=,command=").toString();
  let total = 0;
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || !/ms-playwright/.test(m[3])) continue;
    const p = m[2].split(":");
    total += p.length === 3 ? +p[0] * 3600 + +p[1] * 60 + parseFloat(p[2])
                            : +p[0] * 60 + parseFloat(p[1]);
  }
  return total;
}

const main = async () => {
  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();

  const req = [];
  page.on("request", (r) => {
    try { req.push(new URL(r.url()).pathname); } catch { /* ignore */ }
  });

  // WS route state, flipped between windows.
  let mode = "refuse";
  let attempts = 0, connected = 0;
  const connectTimes = [];
  await page.routeWebSocket("**/api/ws", (ws) => {
    attempts++;
    if (mode === "refuse") { ws.close(); return; }
    // flap: let it through, then drop it after 3s so the app must reconnect
    ws.connectToServer();
    connected++;
    connectTimes.push(Date.now());
    setTimeout(() => { try { ws.close(); } catch { /* already gone */ } }, 3000);
  });

  await page.goto(BASE + "/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await page.goto(BASE + BIG);
  await page.waitForSelector(".block-text", { timeout: 30_000 }).catch(() => {});
  await sleep(5000);

  const run = async (name, ms) => {
    attempts = 0; connected = 0; connectTimes.length = 0; req.length = 0;
    await page.evaluate(() => window.__perfReset());
    const c0 = cpuNow(), t0 = Date.now();
    await sleep(ms);
    const wall = (Date.now() - t0) / 1000;
    const cpu = ((cpuNow() - c0) / wall) * 100;
    const p = await page.evaluate(() => ({ ...window.__perf }));
    const byPath = {};
    for (const u of req) byPath[u] = (byPath[u] || 0) + 1;
    const changes = req.filter((u) => u === "/api/sync/changes").length;
    const per = 60 / wall;
    const out = {
      window: name, sec: +wall.toFixed(0),
      wsAttemptsPerMin: +(attempts * per).toFixed(1),
      wsConnectedPerMin: +(connected * per).toFixed(1),
      changesGetPerMin: +(changes * per).toFixed(1),
      changesPerSuccessfulReconnect: connected ? +(changes / connected).toFixed(2) : null,
      httpReqPerMin: +(req.length * per).toFixed(1),
      setTimeoutPerMin: +(p.st * per).toFixed(1),
      timerFiresPerMin: +((p.stFired + p.siFired) * per).toFixed(1),
      cpuPct: +cpu.toFixed(1),
      longtasks: p.longtasks,
      requestsByPath: byPath,
    };
    console.log("\n" + JSON.stringify(out, null, 1));
    return out;
  };

  // Window 1: exactly scenario E -- WS upgrade refused, HTTP slow-failing.
  await page.route("**/api/sync/changes*", async (r) => {
    await sleep(8000);
    await r.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/ops*", async (r) => {
    await sleep(8000);
    await r.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.reload().catch(() => {});
  await sleep(3000);
  const w1 = await run("E-repeat: WS refused + HTTP 8s->503", WIN);

  // Window 2: WS flapping (each connect dropped after 3s), HTTP healthy --
  // does every successful reconnect pull the changes feed?
  await page.unrouteAll();
  mode = "flap";
  await page.reload().catch(() => {});
  await page.waitForSelector(".block-text", { timeout: 30_000 }).catch(() => {});
  await sleep(3000);
  const w2 = await run("E-b: WS flapping every ~5s, HTTP healthy", WIN);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "ws-probe.json"), JSON.stringify([w1, w2], null, 2));
  await browser.close();
};
main().catch((e) => { console.error(e); process.exit(1); });
