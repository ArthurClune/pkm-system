// Seed the throwaway e2e server (port E2E_PORT, default 8977) with realistic
// content for the runtime-performance measurement:
//   - "Perf Big Page": ~300 nested blocks, [[links]], 2 mermaid, 1 katex, 1 code
//   - 30 daily-journal pages x ~10 blocks
// Run: node seed.mjs
const BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? "8977"}`;
const PASSWORD = "e2e-pw";

let cookie = "";

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) cookie = c.split(";")[0];
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

let n = 0;
const uid = () => `seed${String(n++).padStart(8, "0")}`;
const clientId = "seedclient00000000";

async function postOps(ops) {
  // 500-ops cap per batch (contracts/ops.py OpBatch)
  for (let i = 0; i < ops.length; i += 400) {
    const chunk = ops.slice(i, i + 400);
    await api("/api/ops", {
      method: "POST",
      body: JSON.stringify({ client_id: clientId, batch_id: `seedbatch-${i}-${Date.now()}`, ops: chunk }),
    });
  }
}

const MONTHS = ["January","February","March","April","May","June","July",
                "August","September","October","November","December"];
const suffix = (d) => (d % 100 >= 10 && d % 100 <= 20) ? "th" : ({1:"st",2:"nd",3:"rd"}[d % 10] ?? "th");
const titleForDate = (dt) => `${MONTHS[dt.getMonth()]} ${dt.getDate()}${suffix(dt.getDate())}, ${dt.getFullYear()}`;

const MERMAID = "```mermaid\ngraph TD\n  A[Client] --> B[Replica]\n  B --> C[Server]\n  C --> D[(SQLite)]\n  B --> E[Op queue]\n  E --> C\n```";
const MERMAID2 = "```mermaid\nsequenceDiagram\n  Client->>Server: POST /api/ops\n  Server-->>Client: seq nudge\n  Client->>Server: GET /api/sync/changes\n```";
const KATEX = "$$\\sum_{i=1}^{n} \\frac{i^2}{n^3} \\to \\frac{1}{3} \\quad (n \\to \\infty)$$";
const CODE = "```python\ndef apply_batch(db, batch, now):\n    for op in batch.ops:\n        plan = plan_op(db, op)\n        execute(db, plan, now)\n    return broadcast(batch)\n```";

async function main() {
  await api("/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
  console.log("logged in");

  const today = new Date();
  const dailyTitles = [];
  for (let i = 1; i <= 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dailyTitles.push(titleForDate(d));
  }

  // ---- big page: 300 blocks, 30 sections x 9 children -------------------
  const BIG = "Perf Big Page";
  const ops = [{ op: "create_page", page_title: BIG }];
  let created = 0;
  for (let s = 0; s < 30 && created < 300; s++) {
    const parent = uid();
    ops.push({ op: "create", uid: parent, page_title: BIG, parent_uid: null,
               order_idx: s, text: `Section ${s + 1}: sync behaviour on [[${dailyTitles[s % 30]}]]`,
               heading: s % 5 === 0 ? 2 : null });
    created++;
    for (let c = 0; c < 9 && created < 300; c++) {
      let text;
      if (s === 2 && c === 0) text = MERMAID;
      else if (s === 7 && c === 0) text = MERMAID2;
      else if (s === 11 && c === 0) text = KATEX;
      else if (s === 15 && c === 0) text = CODE;
      else if (c % 3 === 0) text = `Note ${s}.${c} — see [[${dailyTitles[(s + c) % 30]}]] and [[Perf Reference ${c}]] for the retry cadence.`;
      else text = `Observation ${s}.${c}: the drain backoff escalates 250ms, 1s, 5s while the socket reconnects on a fixed two second timer, which means a degraded link produces a steady stream of work rather than an exponential falloff.`;
      ops.push({ op: "create", uid: uid(), page_title: BIG, parent_uid: parent,
                 order_idx: c, text });
      created++;
    }
  }
  await postOps(ops);
  console.log(`big page: ${created} blocks`);

  // ---- 30 daily pages x 10 blocks ---------------------------------------
  const dailyOps = [];
  for (const [i, title] of dailyTitles.entries()) {
    dailyOps.push({ op: "create_page", page_title: title });
    for (let b = 0; b < 10; b++) {
      dailyOps.push({
        op: "create", uid: uid(), page_title: title, parent_uid: null, order_idx: b,
        text: b === 0
          ? `Daily log ${i}: worked on [[Perf Big Page]] sync instrumentation`
          : `- item ${b}: measured op-queue drain latency and websocket reconnect churn under a degraded link (entry ${i}.${b})`,
      });
    }
  }
  await postOps(dailyOps);
  console.log(`daily pages: ${dailyTitles.length} x 10 blocks`);

  const page = await api(`/api/page/${encodeURIComponent(BIG)}`);
  const count = (function walk(bs) { return bs.reduce((a, b) => a + 1 + walk(b.children), 0); })(page.blocks);
  console.log(`verified: ${BIG} has ${count} blocks server-side`);
}

main().catch((e) => { console.error(e); process.exit(1); });
