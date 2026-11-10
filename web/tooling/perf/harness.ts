// pattern: Imperative Shell
// Shared Playwright helpers for check.ts.
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.E2E_PORT ?? "8977";
export const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "e2e-pw";
export const BIG_PAGE = "/page/" + encodeURIComponent("Perf Big Page");
export const INIT = fs.readFileSync(path.join(HERE, "instrument.js"), "utf8");
export const REACT_INIT = fs.readFileSync(path.join(HERE, "react-commits.js"), "utf8");

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface Bag {
  requests: Record<string, number>;
  requestTotal: number;
  wsOpened: number;
  wsSent: number;
  wsRecv: number;
  wsClosed: number;
}

// --------------------------------------------------------------- recorder
export function attachCounters(page: Page, bag: Bag): void {
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
export const freshBag = (): Bag => ({ requests: {}, requestTotal: 0, wsOpened: 0,
                                 wsSent: 0, wsRecv: 0, wsClosed: 0 });
export function resetBag(bag: Bag): void {
  bag.requests = {}; bag.requestTotal = 0;
  bag.wsOpened = 0; bag.wsSent = 0; bag.wsRecv = 0; bag.wsClosed = 0;
}

export async function login(page: Page): Promise<void> {
  await page.goto(BASE + "/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
}
