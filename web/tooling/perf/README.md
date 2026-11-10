# Frontend performance gate

`check.mjs` runs headless via `perf/check.sh` and compares what the SPA does
against the committed baseline in `perf/`.
[docs/architecture/checks.md](../../../docs/architecture/checks.md#performance-gate)
describes how it reaches a verdict and keeps its counts deterministic.
`harness.mjs` holds its Playwright setup.

An earlier headed investigation toolkit (seed, scenario runner, probes) was
retired once the gate covered its scenarios. `baselines/<date>/` is its
record: written-up reports plus the raw results. A report may record a change
that was *not* shipped (`2026-09-02-muka`); the numbers are the point, not the
outcome. The scripts those reports name no longer exist; `git log` has them.

| File | Role |
|---|---|
| `check.mjs` | the gate; each metric declares its class there |
| `harness.mjs` | login, request/WebSocket counters, shared constants |
| `instrument.js` | `addInitScript` payload: wraps timers/fetch/WebSocket, observes long tasks and outline DOM mutations, exposes `window.__perf` |
| `react-commits.js` | `addInitScript` payload for scenario J: a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` counting commits and re-rendered fibers into `window.__react` |
| `rebase.perf.ts`, `rebaseTargets.ts`, `vitest.rebase.config.ts` | scenario R (SQL counts of `applyChanges` over a pending queue), run by `check.mjs` as a vitest subprocess |
| `sqlcount.ts` | SQL counter used by R: statements, trigger statements, VM steps, full scans |
| `contextGroups.ts` | scenario context grouping used by `check.mjs` |

## Read the numbers with these caveats

- **`context.setOffline(true)` measures nothing useful.** It burns 60-100 %
  CPU inside Chromium's own NetworkService process and never closes the app's
  WebSocket, so the reconnect path never runs. Simulate a bad link with
  `page.routeWebSocket` (refuse the upgrade) plus delayed-503 `page.route`s.
- **Scenarios J and K install J's commit hook**, which walks the fiber tree
  on every commit, so their `cpu%` is inflated; trust the counts (commits and
  fibers per keystroke). A re-rendered fiber is not a DOM write, so J sees
  churn that `mut`/`mutOutside` cannot.
- **Scenario K's drag is synthetic.** The page dispatches its own `DragEvent`s
  at the drop zone, so the timing is the app's `dragover` handler alone. It
  says nothing about a real drag's frame rate or touch DnD: iPad needs a
  physical-device check.
- **`routeWebSocket` replaces `window.WebSocket` after `addInitScript`**, so
  the in-page `newWS` counter reads 0 whenever a WebSocket route is active.
- **A second `bringToFront()` page does not hide the first**
  (`visibilityState` stays `visible`).
