---
# pkm-fgjg
title: Frontend performance and energy use
status: in-progress
type: epic
priority: normal
created_at: 2026-09-01T21:26:51Z
updated_at: 2026-09-02T04:00:49Z
---

Umbrella for the 2026-09-01 frontend performance/energy investigation, prompted by heavy laptop CPU on train wifi (the specific FK wedge was fixed in pkm-qvlx; this is the general follow-up).

## Findings in one paragraph

Measured (headed Chromium, 300-block page + 30 journal days): idle is clean — 0 timers, 0 fetches, ~30 ms main-thread work/min. The cost is in *reconnecting*, not in being disconnected: a dead link costs 1.2% CPU (30 `new WebSocket()`/min, fixed 2 s reconnect); a *flapping* link costs 3.4% because every successful reconnect triggers exactly one `GET /api/sync/changes` + one page refetch, and on the Journal that `reset()` refetches every loaded day via an N+1 `GET /api/page/<date>` (measured 157 req/min scrolling). Typing costs 20% of a core and is layout-bound (3 forced layouts/keystroke from textarea auto-resize), not React-bound. Server CPU negligible throughout.

Reconstructed train symptom: server drops WS clients whose send exceeds 1 s (`ws.py` SEND_TIMEOUT) → reconnect 2 s later → drain + pull + `resyncSeq` bump → Journal refetches every loaded day (N+1) → every mounted outline re-renders → repeat 10-20×/min with no user input.

## Where the detail lives

The re-runnable Playwright measurement harness (`seed.mjs`, `perf.mjs`, `ws-probe.mjs`, `summarize.mjs`) is committed at `web/tooling/perf/` with the recipe and Playwright caveats in its README; the pre-fix baseline (`results.json`, `ws-probe.json`, report) is `web/tooling/perf/baselines/2026-09-01/`. The three full sub-reports (sync/background audit, rendering audit, runtime measurement) remain in the gitignored local dir `docs/superpowers/handoffs/2026-09-01-frontend-perf/`. Re-measure after each child lands.

Measurement gotcha: Playwright `context.setOffline(true)` burns 60-100% CPU in Chromium's NetworkService and never closes the app's WebSocket — useless for this. Use `routeWebSocket` refusal + delayed-503 routes instead (that is what `ws-probe.mjs` does).

## Already good — do not "fix"

No polling anywhere; `seq` nudges do not fan out refetches (other tab: 0 requests per edit); pulls single-flight; op queue never POSTs while socket down; service worker clean (99 KB returning-user load, no update polling, /api never cached); one 1.6 s one-shot CSS animation; keystroke path touches no tree state; mermaid/KaTeX/pdf.js lazy + budgeted; replica worker has no periodic work.

## Order

Tier 1 children first (they break the multiplication chain), re-measure, then Tier 2 (only matters while typing/scrolling), Tier 3 as convenient.

## Status 2026-09-02

All nine original children have landed on main (pkm-d6i6, 5fak, gw5r, youp, l33u, qfee, cpke, ikk0, ey1f), each with a per-task review, plus a whole-branch final review whose fix wave merged as e16120a. Post-fix baselines are under web/tooling/perf/baselines/2026-09-02-*/.

Follow-ups from the final review also landed (2026-09-02): pkm-uue4 (proof-of-life backoff reset; stale-resume socket restart), pkm-8k2c (offline cold start bootstraps once the socket opens), pkm-muka (BlockMenu/BlockRefBacklinksPopover portalled to body; `content-visibility: auto` on `.journal-day` was measured and rejected — layouts 8→44 on scenario I — numbers in web/tooling/perf/baselines/2026-09-02-muka/).

pkm-youp's iPad check was done in the simulator (iPadOS 26.5 WebKit takes the `field-sizing: content` path; heights grow and shrink cleanly) and the bean is complete.

Still open under this epic — one physical-device check, nothing left for an agent:
- pkm-ikk0: iPad drag check. The simulator fires `dragstart` but UIKit swallows post-lift moves, so `dragover`/`drop` can only be exercised on a real iPad.

Accepted without change from the final review: DndContext api identity flips twice per drag (two full-tree re-renders at drag start/end); useEffectiveTheme re-reads the DOM per consumer render (one consumer today).
