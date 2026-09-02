# Frontend performance harness

Playwright scripts that measure what the SPA actually does — timers, fetches,
WebSocket attempts, forced layouts, long tasks, CPU — under idle, degraded
network, typing, multi-tab, journal scroll, outline drag and cold load.
Written for the 2026-09-01 investigation (epic pkm-fgjg); rerun after any
change to sync, reconnect, the editor keystroke path, the Journal loader or
the drop zone, and compare with `baselines/`.

Not part of `pnpm verify`. Nothing here is a test; the numbers are for a
human to read.

## Run

```sh
cd web && CI=true pnpm build                              # scripts drive web/dist
cd server && E2E_PORT=8977 uv run python tests/e2e_serve.py &   # throwaway server, fresh DB
cd web/tooling/perf
node seed.mjs                            # 300-block "Perf Big Page" + 30 daily pages
HEADLESS=0 DUR=60000 node perf.mjs      # all valid scenarios; pass letters (e.g. `AF`) to pick
HEADLESS=0 node perf.mjs J               # React commits / re-rendered fibers per keystroke
HEADLESS=1 node perf.mjs K               # dragover handler ms, commits/s, forced layouts
node summarize.mjs                       # out/results.json -> markdown table
HEADLESS=0 WIN=60000 node ws-probe.mjs   # dead-link and flapping-link reconnect accounting
pkill -f tests/e2e_serve.py
```

Never point this at 8974 (prod) or 8975 (`pnpm e2e`). `E2E_PORT` defaults
to 8977 in every script. Outputs land in `out/` (gitignored).

| Script | Answers |
|---|---|
| `seed.mjs` | seeds content through `POST /api/ops`, same as a client would |
| `instrument.js` | `addInitScript` payload: wraps timers/fetch/WebSocket, observes long tasks and outline DOM mutations, exposes `window.__perf` |
| `react-commits.js` | `addInitScript` payload for J: a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` counting commits and re-rendered fibers into `window.__react` |
| `perf.mjs` | scenarios A (idle, big page), B (idle, journal), E (degraded: WS refused, HTTP 8 s → 503), E2 (degraded + pending edit), F (typing), G (two tabs), H (cold load, SW warm and cold), I (journal scroll), J (journal with every seeded day mounted: React commits and re-rendered fibers per keystroke), K (outline drag: dragover handler ms/event, commits/s, forced layouts) |
| `ws-probe.mjs` | attempts/min on a dead link; changes-pulls and page refetches per successful reconnect on a flapping link |
| `offline-probe.mjs` | per-process CPU attribution — exists to show why `context.setOffline` is unusable (below) |
| `summarize.mjs` | table from `out/results.json` (or a path given as argv) |

## Read the numbers with these caveats

- **`context.setOffline(true)` measures nothing useful.** It burns 60–100 %
  CPU inside Chromium's own NetworkService process and never closes the app's
  WebSocket, so the reconnect path never runs. Scenario D in the baseline is
  invalid for this reason; `perf.mjs` skips C and D unless asked for by
  letter. Simulate a bad link with `page.routeWebSocket` (refuse the
  upgrade) plus delayed-503 `page.route`s, which is what E and `ws-probe.mjs`
  do.
- **Scenario J is opt-in by letter**, like C and D, for the opposite reason:
  its DevTools hook walks the fiber tree on every commit, so leaving it
  installed would inflate the CPU and long-task figures of every other
  scenario. Trust J's counts (commits and fibers per keystroke), not its
  `cpu%`. A re-rendered fiber is not a DOM write — React reconciles an
  unchanged render to nothing — so J sees churn that `mut`/`mutOutside`
  cannot.
- **Scenario K's drag is synthetic, and that is the point.** Playwright's
  mouse cannot drive a native HTML5 drag loop, so the page dispatches its own
  `DragEvent`s (one shared `DataTransfer`) straight at the drop zone at a
  ~60 Hz pace. `dispatchEvent` runs listeners synchronously, so the
  `performance.now()` bracket around it is the app's `dragover` handler and
  nothing else — no hit-testing, no drag-image compositing. It therefore does
  **not** prove anything about a real drag's frame rate, and says nothing
  about touch DnD: iPad needs a physical-device check (the simulator cannot
  drive post-lift drag moves). K also installs J's commit hook, so it is
  opt-in by letter and its `cpu%` is not to be trusted. Headless is fine for
  K, which measures handler time and commits rather than paint.
- **`routeWebSocket` replaces `window.WebSocket` after `addInitScript`**, so
  the in-page `newWS` counter reads 0 whenever a WebSocket route is active.
  `ws-probe.mjs` counts attempts in the route handler instead.
- **A second `bringToFront()` page does not hide the first**
  (`visibilityState` stays `visible`, recorded in the `vis` column). Tab-hidden
  behaviour needs `Page.setWebLifecycleState` or a real backgrounded window.
- **`cpu%` is true utilisation of one core**: cumulative `ps time=` deltas
  summed over every `ms-playwright` process (browser, renderers, GPU, network
  service) over wall time. It includes the sqlite-wasm worker, which shares
  the page's renderer process. The CDP `task_s/min` column is the page target
  only and excludes the worker.
- Headed (`HEADLESS=0`) is the higher-fidelity mode; headless does no real
  compositing and throttles differently. Short scenarios (F, G, I) are single
  runs — trust their counter-derived ratios (per keystroke, per reconnect)
  over their CPU figures.

## Baselines

`baselines/<date>/` holds the written-up report plus whatever the run
produced: `results.json` and `ws-probe.json` for a whole-harness sweep, or a
`before.json`/`after.json` pair for one change measured either side of itself
— prefixed (`heavy-before.json`) when a second fixture was measured too.
`2026-09-01` is the pre-fix state at commit `5e68dd6`. A report may record a
change that was *not* shipped (`2026-09-02-muka`); the numbers are the point,
not the outcome.
