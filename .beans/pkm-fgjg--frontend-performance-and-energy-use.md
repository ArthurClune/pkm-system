---
# pkm-fgjg
title: Frontend performance and energy use
status: todo
type: epic
created_at: 2026-09-01T21:26:51Z
updated_at: 2026-09-01T21:26:51Z
---

Umbrella for the 2026-09-01 frontend performance/energy investigation, prompted by heavy laptop CPU on train wifi (the specific FK wedge was fixed in pkm-qvlx; this is the general follow-up).

## Findings in one paragraph

Measured (headed Chromium, 300-block page + 30 journal days): idle is clean — 0 timers, 0 fetches, ~30 ms main-thread work/min. The cost is in *reconnecting*, not in being disconnected: a dead link costs 1.2% CPU (30 `new WebSocket()`/min, fixed 2 s reconnect); a *flapping* link costs 3.4% because every successful reconnect triggers exactly one `GET /api/sync/changes` + one page refetch, and on the Journal that `reset()` refetches every loaded day via an N+1 `GET /api/page/<date>` (measured 157 req/min scrolling). Typing costs 20% of a core and is layout-bound (3 forced layouts/keystroke from textarea auto-resize), not React-bound. Server CPU negligible throughout.

Reconstructed train symptom: server drops WS clients whose send exceeds 1 s (`ws.py` SEND_TIMEOUT) → reconnect 2 s later → drain + pull + `resyncSeq` bump → Journal refetches every loaded day (N+1) → every mounted outline re-renders → repeat 10-20×/min with no user input.

## Where the detail lives

Full sub-reports (sync/background audit, rendering audit, runtime measurement) and the re-runnable Playwright measurement scripts (`perf.mjs`, `ws-probe.mjs`, `seed.mjs`) are in the gitignored local dir `docs/superpowers/handoffs/2026-09-01-frontend-perf/`. Re-run recipe is at the end of `measure-runtime-report.md`. Re-measure after each child lands.

Measurement gotcha: Playwright `context.setOffline(true)` burns 60-100% CPU in Chromium's NetworkService and never closes the app's WebSocket — useless for this. Use `routeWebSocket` refusal + delayed-503 routes instead (that is what `ws-probe.mjs` does).

## Already good — do not "fix"

No polling anywhere; `seq` nudges do not fan out refetches (other tab: 0 requests per edit); pulls single-flight; op queue never POSTs while socket down; service worker clean (99 KB returning-user load, no update polling, /api never cached); one 1.6 s one-shot CSS animation; keystroke path touches no tree state; mermaid/KaTeX/pdf.js lazy + budgeted; replica worker has no periodic work.

## Order

Tier 1 children first (they break the multiplication chain), re-measure, then Tier 2 (only matters while typing/scrolling), Tier 3 as convenient.
