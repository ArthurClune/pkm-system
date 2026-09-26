// pattern: Imperative Shell
// Shared Playwright helpers for perf.mjs (investigation) and check.mjs (gate).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORT = process.env.E2E_PORT ?? "8977";
export const BASE = `http://127.0.0.1:${PORT}`;
export const PASSWORD = "e2e-pw";
export const BIG_PAGE = "/page/" + encodeURIComponent("Perf Big Page");
export const INIT = fs.readFileSync(path.join(HERE, "instrument.js"), "utf8");
export const REACT_INIT = fs.readFileSync(path.join(HERE, "react-commits.js"), "utf8");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- recorder
export function attachCounters(page, bag) {
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
export const freshBag = () => ({ requests: {}, requestTotal: 0, wsOpened: 0,
                                 wsSent: 0, wsRecv: 0, wsClosed: 0 });
export function resetBag(bag) {
  bag.requests = {}; bag.requestTotal = 0;
  bag.wsOpened = 0; bag.wsSent = 0; bag.wsRecv = 0; bag.wsClosed = 0;
}

export async function login(page) {
  await page.goto(BASE + "/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
}
