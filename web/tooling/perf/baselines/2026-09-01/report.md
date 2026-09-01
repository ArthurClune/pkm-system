# Runtime performance / energy measurement — PKM SPA

**Date:** 2026-09-01 · **Repo:** `/Users/arthur/code/llm/pkm` @ `5e68dd6` (read-only; nothing modified, `git status` clean)

## Method

Headed Chromium (`headless: false`) driven by Playwright 1.61.1 from `web/node_modules`, against a throwaway
server (`server/tests/e2e_serve.py`, `E2E_PORT=8977`, fresh temp DB) serving `web/dist`. Port 8974 (prod) and
8975 (`pnpm e2e`) were never touched.

Seeded content: one page **"Perf Big Page"** with 300 blocks (30 sections × 9 children, nested), containing
`[[links]]`, two ` ```mermaid ` blocks, a `$$…$$` KaTeX block and a ` ```python ` code block; plus **30
daily-journal pages × 10 blocks**.

Instrumentation:

- `page.addInitScript` wrapping `setTimeout` / `setInterval` / `requestAnimationFrame` / `fetch` /
  `XMLHttpRequest.open` / the `WebSocket` constructor, counting both *scheduled* and *fired*; a
  `PerformanceObserver` for `longtask`; a `MutationObserver` over the outline root splitting mutations by
  whether they land inside the focused block. Exposed on `window.__perf`, zeroed per scenario via
  `window.__perfReset()`.
- CDP `Performance.enable` + `Performance.getMetrics` deltas per scenario.
- `page.on('request')` bucketed by URL path; `page.on('websocket')` → `framesent` / `framereceived`.
- **CPU**: cumulative `ps -o time=` deltas (macOS reports hundredths) summed over *every* `ms-playwright`
  process — browser, renderers, GPU, network service — divided by wall time. This is true average
  utilisation of one core, not `%cpu`'s decaying lifetime average. It **includes the sqlite-wasm worker**,
  since a dedicated worker shares its page's renderer process. The same technique sampled the uvicorn server.

Idle scenarios ran 60 s. All rates are normalised **per minute**.

---

## 1. Scenarios × metrics

| scenario | cpu% | srv% | task s/min | script s/min | layouts/min | styles/min | setTimeout/min | timer fires/min | fetch/min | httpReq/min | wsSent/recv per min | longtasks/min | heapMB | nodes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A** idle, online, foreground, big page | 0.9 | 0.15 | 0.034 | 0.000 | 0 | 0 | **0** | 2 | **0** | **0** | 2 / 0 | 0 | 14.9 | 3671 |
| **B** idle, online, `/journal` | 0.4 | 0.13 | 0.023 | 0.000 | 0 | 0 | **0** | 2 | **0** | **0** | 2 / 0 | 0 | 9.5 | 678 |
| **C** idle, tab "hidden" ⚠️ *invalid* | 0.4 | 0.12 | 0.036 | 0.000 | 0 | 0 | 0 | 2 | 0 | 0 | 2 / 0 | 0 | 15.0 | 3671 |
| **D** offline idle ⚠️ *invalid* | **60.2** | 0.07 | 0.003 | 0.000 | 0 | 0 | **0** | 2 | **0** | **0** | 2 / 0 | 0 | 15.7 | 3672 |
| **D2** offline + second tab ⚠️ *invalid* | **100.1** | 0.02 | 0.006 | 0.000 | 0 | 0 | 0 | 2 | 0 | 0 | 2 / 0 | 0 | 15.7 | 3672 |
| **E** degraded (8 s → 503, WS refused) | **1.2** | 0.13 | 0.182 | 0.087 | 1 | 2 | **41** | 35 | 0 | **0** | 0 / 0 | 0 | 17.7 | 3374 |
| **E2** degraded + pending edit | 0.4 | 0.12 | 0.072 | 0.032 | 0 | 0 | **32** | 31 | 0 | 0 | 0 / 0 | 0 | 19.4 | 3389 |
| **F** typing 200 ch @ 60 ms (14.6 s) | 19.9 | 0.21 | 5.42 | 0.77 | **2466** | **1648** | 847 | 4 | 12.3 | 12.3 | 0 / 8.2 | 0 | 18.8 | 3680 |
| **G** multi-tab, 50 ch in tab 1 (7.2 s) | 14.1 | 0.55 | 3.29 | 0.58 | 1225 | 817 | 475 | 17 | 33.3 | 33.3 | 8.3 / 16.7 | 0 | 18.4 | 3689 |
| **I** journal scroll, 40 steps (12.2 s) | 11.5 | **1.80** | 1.74 | 0.69 | 64 | 246 | 0 | 0 | **157** | **157** | 0 / 0 | 0 | 11.6 | 4424 |

`srv%` = uvicorn CPU during the same window. `heapMB` / `nodes` are absolute values at scenario end, not deltas.

### Follow-up probe: WebSocket reconnect accounting (`ws-probe.mjs`)

Run separately because Playwright's `page.routeWebSocket` installs its own `window.WebSocket` mock *after*
the init script, blinding the in-page counter (this is why scenario E's table row shows 0 constructions).
Counting the route handler's invocations measures connection attempts directly.

| window (60 s each) | WS attempts/min | WS connects/min | `/api/sync/changes` per min | per successful reconnect | httpReq/min | setTimeout/min | cpu% |
|---|---|---|---|---|---|---|---|
| WS upgrade refused + HTTP 8 s → 503 (= scenario E) | **30.0** | **0** | 0 | n/a — none succeeded | 0 | 30 | 1.2 |
| WS flapping (connect, dropped after 3 s), HTTP healthy | 12.0 | 12.0 | **12.0** | **exactly 1.0** | 24.0 | 48 | 3.4 |

### Per-keystroke cost, derived from F (200 characters)

| | per keystroke |
|---|---|
| main-thread task time | **6.6 ms** |
| forced layouts | **3** |
| style recalculations | **2** |
| `setTimeout` scheduled | 1.03 |
| DOM mutations in the outline | **1** |
| DOM mutations *outside* the focused block | **0** |
| `POST /api/ops` | 0.005 (one POST for the whole 200 characters) |

### H. Cold load (big page, 300 blocks)

| | SW warm (returning user) | SW blocked (true cold) |
|---|---|---|
| `load` event | 26 ms | 26 ms |
| first visible block | 185 ms | **158 ms** |
| JS chunks | 5 | 5 |
| JS transferred | **0 KB** (served from SW precache) | **1759 KB** |
| JS decoded | 2283 KB | 2538 KB |
| total transferred | **99 KB** | 2137 KB |
| resources / HTTP requests | 13 / 15 | 16 / 24 |
| initial JS heap | 21.0 MB | 19.6 MB |
| DOM nodes | 3693 | 3679 |
| TaskDuration / ScriptDuration | 0.20 s / 0.07 s | 0.21 s / 0.07 s |
| LayoutDuration / RecalcStyleDuration | — | 0.02 s / 0.01 s |
| longtasks | **0** | **0** |

---

## 2. Notable observations

**1. Idle costs literally nothing — there is no polling loop anywhere.**
Scenarios A and B schedule **zero** `setTimeout`s, make **zero** fetches, and burn 23–34 ms of page-thread
task time *per minute*. The only recurring work in the whole app is the socket's 30 s keepalive ping
(2 frames/min). This matches the source: grepping `web/src` for `setInterval` finds exactly two — the socket
ping in `web/src/sync/socket.ts:46` and a 1 s clock in `AssistantPanel.tsx` that only runs while the panel is
open. Whatever heats the laptop on a train, **it is not an idle timer in this app**.

**2. The 60 % → 100 % "offline" figure is a Playwright/Chromium artifact, not your code.**
Per-process attribution (`offline-probe.mjs`) puts the burn at **88.8 % in Chromium's `NetworkService`
utility process** while `context.setOffline(true)` is in force; the page's renderer sat at 0.4 %. Worse, the
emulated-offline mode **never closed the app's WebSocket** — the keepalive kept firing, no reconnect timer
armed, zero `new WebSocket` constructions. So scenario D measured Chromium's emulation misbehaving and never
exercised the reconnect path at all. **Discard D and D2.** The valid degraded numbers are E and the WS probe.

**3. Under a genuinely dead link the client opens 30 sockets a minute, forever, for 1.2 % CPU.**
`socket.ts` uses a **fixed 2 s reconnect with no backoff** (`RECONNECT_MS = 2000`), and the probe confirms
exactly **30.0 constructions/min**, indefinitely, none succeeding. That is the one unbounded cadence in the
system — but it costs ~1 % of a core, so it is a tidiness problem, not an energy sink. Adding backoff would
be defensible; it will not measurably change battery life.

**4. A *flapping* link is roughly 3× costlier than a dead one, and each reconnect costs two HTTP round-trips.**
With the socket dropped every ~3 s on an otherwise-healthy link: 12 reconnects/min, and **every single
successful reconnect triggered exactly one `GET /api/sync/changes` (ratio 1.00) plus one
`GET /api/page/<current page>`** — 24 requests/min, 3.4 % CPU. That is `resyncSeq` doing what
`sync-and-offline.md` says it does (bumped on reconnect-after-gap, making visible views refetch). It is
correct behaviour, but on a link that flaps every few seconds it means a full page refetch per flap. **This
is the closest thing in the measurements to the reported train-wifi symptom**, and it is the one worth
looking at: the cost scales with how often the link comes *back*, not with how broken it is.

**5. Once the changes pull fails, the app stops issuing HTTP entirely.**
In scenario E the client made **zero** HTTP requests in 60 s. The banner reads *"Local sync is stuck: offline:
/api/sync/changes?since=N is unavailable without a connection · Reset local data"*. There is no retry storm —
arguably the opposite concern (a link that recovers silently may leave the user latched into a stuck state
until something else kicks the queue). The op queue's 250 ms / 1 s / 5 s backoff never escalates beyond 5 s
(`queueState.ts` `RETRY_DELAYS`), and `replicaSync.ts` backs off exponentially to a 60 s ceiling — both
well-behaved.

**6. Typing is the real main-thread cost, and it is layout-bound, not React-bound.**
19.9 % CPU sustained at human typing speed; 5.42 s of task time per minute of typing. The split is the
interesting part: **0.77 s/min scripting versus 2466 layouts/min and 1648 style recalcs/min** — 3 forced
layouts and 2 style recalculations *per character*. Scripting is under a seventh of total task time. If
anything here deserves optimisation it is whatever forces synchronous layout on each keystroke (a likely
suspect is textarea auto-resize measuring `scrollHeight`), not the render path.

**7. Re-render fan-out on typing is zero — that suspicion is cleared.**
The MutationObserver over the outline root recorded **exactly 200 mutations for 200 keystrokes, 0 of them
outside the focused block**. The block tree does not re-render as you type. And 200 characters produced a
single `POST /api/ops` — the debounce in `useOutline.ts:289` works as designed.

**8. Multi-tab fan-out is also near-zero.**
50 characters typed in tab 1 produced, in tab 2: **0 HTTP requests, 0 fetches, 2 WebSocket frames received,
and 11.5 ms of total task time**. The seq nudge reaches the second tab without provoking a refetch. There is
no per-edit fan-out cost to keeping tabs open.

**9. The journal view has an N+1 fetch pattern — the only genuine network finding.**
Scrolling the journal 40 wheel-steps issued **32 requests in 12.2 s (157/min)**: 6 × `/api/journal` plus
**27 separate `GET /api/page/<date>` calls, one per day rendered**. It is also the only scenario that moved
the server needle (**1.8 % server CPU**, ~14× idle). On a slow link this is 27 sequential round-trips where a
batched endpoint would be one — a plausible contributor to "the journal feels slow on bad wifi".

**10. The service worker is earning its keep.**
A returning user's cold load transfers **99 KB** instead of 2137 KB — everything else comes from the precache.
300 blocks render to first visible block in ~160 ms, and there were **no longtasks anywhere in the entire
run**, cold load included. (The observer is verified working: a synthetic 300 ms block produced 1 entry.)

**11. Server-side cost is negligible throughout** — 0.02–0.21 % of a core except during the journal scroll
(1.8 %). Prod sharing the laptop with the browser is not a contributor to the reported heat.

---

## 3. Caveats

- **Scenario C is invalid — the tab-hidden question is unanswered.** `page.bringToFront()` on a second page
  does not background the first in Playwright: `document.visibilityState` read `visible` at both ends of the
  window (recorded deliberately to catch exactly this). C is a duplicate of A. Since A already does zero
  work, the question only matters for the E/flapping cadences; answering it properly needs a real
  backgrounded OS window or `Page.setWebLifecycleState`.
- **Scenarios D and D2 are invalid** — Chromium's offline emulation both spun its own network service and
  failed to close the app's WebSocket (observation 2). Use E and the WS probe instead.
- **`newWS/min` reads 0 in the scenario-E table row** because `page.routeWebSocket` replaces
  `window.WebSocket` after the init script, bypassing both the in-page wrapper and Playwright's own
  `page.on('websocket')`. The reconnects did happen — the timer counts show them, and `ws-probe.mjs`
  measures them directly at 30.0/min.
- **Headless vs headed**: everything above is **headed** Chromium, which is the higher-fidelity option (a
  headless build throttles hidden-tab timers differently and does no real compositing). A headless smoke run
  of A gave the same near-zero idle profile.
- **Environment**: idle Mac, localhost server, no network latency, no thermal pressure, no other tabs.
  Absolute CPU on a real degraded connection will be higher; the **ratios between scenarios** are the
  transferable part.
- **Worker CPU is not broken out.** `Target.setAutoAttach` onto the sqlite-wasm worker was deprioritised
  within the time budget. The worker's CPU *is* included in the `cpu%` column (it shares the renderer
  process); it is *not* in the CDP `task s/min` column, which is page-target only. The one page worker seen
  was `/app-assets/worker-DWImy7O7.js`.
- **`wasmTransferKB` reads 0** in the cold-load table because the sqlite wasm is fetched by the worker, and
  worker fetches do not appear in the page's resource timing. It is visible in the request log
  (`/app-assets/sqlite3-BVKGSWc-.wasm`).
- F, G and I are single runs of short duration (7–15 s); treat their CPU figures as indicative, the
  per-keystroke ratios (which come from counters, not timing) as solid.

---

## 4. Scripts — all in the scratchpad, re-runnable after fixes

```
/private/tmp/claude-501/-Users-arthur-code-llm-pkm/d90ef364-42fb-461a-b83b-0bab3e1f2cc2/scratchpad/
├── seed.mjs                  # content seeding via POST /api/ops (300-block page + 30 daily pages)
├── instrument.js             # addInitScript payload: timer/fetch/WS/longtask/mutation counters
├── perf.mjs                  # scenarios A–I                    -> results.json
├── offline-probe.mjs         # per-process CPU attribution      -> offline-probe.json
├── ws-probe.mjs              # WS reconnect + changes-pull ratio -> ws-probe.json
├── summarize.mjs             # results.json -> the markdown table above
├── results.json, offline-probe.json, ws-probe.json
├── run-headed.log, build.log, server.log, server2.log
└── node_modules -> /Users/arthur/code/llm/pkm/web/node_modules
    package.json  ({"type":"module"}, so plain `node` resolves @playwright/test)
```

To re-run:

```sh
cd /Users/arthur/code/llm/pkm/web && CI=true pnpm build
cd /Users/arthur/code/llm/pkm/server && E2E_PORT=8977 uv run python tests/e2e_serve.py &

cd /private/tmp/claude-501/-Users-arthur-code-llm-pkm/d90ef364-42fb-461a-b83b-0bab3e1f2cc2/scratchpad
node seed.mjs
HEADLESS=0 DUR=60000 node perf.mjs ABEFGHI   # skip C and D — see caveats
node summarize.mjs
HEADLESS=0 WIN=60000 node ws-probe.mjs
pkill -f tests/e2e_serve.py
```

`DUR` sets the idle-scenario length (ms), `WIN` the probe window, `HEADLESS=1` forces headless. The
positional argument to `perf.mjs` is the scenario letters to run.
