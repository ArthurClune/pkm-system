// Render results.json as a markdown table of per-minute rates.
import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(new URL(process.argv[2] ?? "./out/results.json", import.meta.url)));
const rows = [];
for (const [k, v] of Object.entries(r)) {
  if (!v || !v.perf) continue;
  const p = v.perf[0], b = v.bags[0], c = v.cdp[0];
  const per = 60 / v.wallSec;
  const rate = (n) => +(n * per).toFixed(1);
  rows.push({
    scenario: v.name,
    sec: v.wallSec,
    vis: v.visibility.join("/"),
    "cpu%": v.browserCpuPct,
    "srv%": v.serverCpuPct,
    "task_s/min": +(c.TaskDuration * per).toFixed(3),
    "script_s/min": +(c.ScriptDuration * per).toFixed(3),
    "layout_s/min": +(c.LayoutDuration * per).toFixed(3),
    "style_s/min": +(c.RecalcStyleDuration * per).toFixed(3),
    "layouts/min": rate(c.LayoutCount),
    "styles/min": rate(c.RecalcStyleCount),
    "setTimeout/min": rate(p.st),
    "timerFires/min": rate(p.stFired + p.siFired),
    "raf/min": rate(p.raf),
    "fetch/min": rate(p.fetch + p.xhr),
    "newWS/min": rate(p.ws),
    "httpReq/min": rate(b.requestTotal),
    "wsSent/min": rate(b.wsSent),
    "wsRecv/min": rate(b.wsRecv),
    "longtasks/min": rate(p.longtasks),
    "longtaskMs/min": +(p.longtaskMs * per).toFixed(0),
    "maxLongtaskMs": +p.maxLongtask.toFixed(0),
    heapMB: +(c.JSHeapUsedSize / 1048576).toFixed(1),
    nodes: c.Nodes,
    listeners: c.JSEventListeners,
    mut: p.mut, mutOutside: p.mutOutside,
    rssMB: v.browserRssMB, procs: v.browserProcs,
    fetchUrls: JSON.stringify(p.fetchUrls),
    reqUrls: JSON.stringify(b.requests),
  });
}
const cols = Object.keys(rows[0] ?? {}).filter((c) => c !== "fetchUrls" && c !== "reqUrls");
console.log("| " + cols.join(" | ") + " |");
console.log("|" + cols.map(() => "---").join("|") + "|");
for (const row of rows) console.log("| " + cols.map((c) => row[c]).join(" | ") + " |");
console.log("\n### URL detail\n");
for (const row of rows) {
  console.log(`- **${row.scenario}**\n  - in-page fetch: ${row.fetchUrls}\n  - network requests: ${row.reqUrls}`);
}
console.log("\n### Cold load\n");
for (const k of ["H", "H2"]) if (r[k]) console.log(k, JSON.stringify(r[k], null, 1));
if (r.workers) console.log("\nworkers:", JSON.stringify(r.workers));
if (r["G multitab type50"]) {
  const g = r["G multitab type50"];
  console.log("\n### G tab-2 (observer tab) detail\n", JSON.stringify({
    perf: g.perf[1], bag: g.bags[1], cdp: g.cdp[1],
  }, null, 1));
}
