# Frontend perf re-measurement — Tier 1 fixes (pkm-d6i6, pkm-5fak)

**Date:** 2026-09-02 · repo `/Users/arthur/code/llm/pkm` @ `0b4cfaf` (main HEAD, includes both merges)
· baseline: `2026-09-01` @ `5e68dd6` in `../2026-09-01/`.

## Commands run

```sh
cd web && CI=true pnpm build
cd server && E2E_PORT=8977 uv run python tests/e2e_serve.py &
cd web/tooling/perf && node seed.mjs
WIN=60000 node ws-probe.mjs
DUR=60000 node perf.mjs BEI
node summarize.mjs
pkill -f tests/e2e_serve.py
```

## Headless/headed

Neither script was given `HEADLESS=1`, and both default to **headed**
Chromium (`HEADLESS = process.env.HEADLESS === "1"`) — same as the 2026-09-01
baseline, so `cpu%` here is directly comparable, not just the counter ratios.

## Headline metrics: before -> after

| metric | before (09-01) | after (09-02) | verdict |
|---|---|---|---|
| dead-link WS attempts/min | 30.0 | **4.0** | improved, at the edge of the "≤4" target |
| dead-link setTimeout/min | 30 | 4 | improved |
| flapping-link changes-pulls per reconnect | 1.00 | **1.00** | unchanged, as expected |
| flapping-link `/api/page/<page>` per reconnect | 1.00 | **0** | improved — refetch gone |
| flapping-link httpReq/min | 24 | 12 | improved (only `/api/sync/changes` left) |
| journal scroll `/api/page/<date>` per scroll (40 steps) | 27 | **0** | improved — N+1 gone |
| journal scroll `/api/journal` requests | 6 | 6 | unchanged (expected — batched endpoint, not touched) |
| journal scroll total httpReq/min | 157 | **29.5** | improved (~5.3x drop) |
| journal scroll cpu% | 11.5 | 9.4 | improved, roughly consistent with fewer requests |
| journal scroll srv% | 1.80 | 0.66 | improved |
| idle journal (B) cpu% | 0.4 | 0.7 | within single-run noise, still near-zero |
| degraded idle (E) cpu% | 1.2 | 0.8 | comparable/improved |
| degraded idle (E) setTimeout/min | 41 | 15 | improved (fewer reconnect timers armed) |

## Did not improve / needs a caveat

- Dead-link attempts/min landed **exactly at 4**, the stated upper bound, not
  comfortably under it: with 2 s -> 30 s backoff, a 60 s window only fits
  ~4-5 attempts before hitting the cap, so 4/min is the expected steady
  state, not headroom.
- `/api/journal` request count (6 per 40-wheel-step scroll) is unchanged, as
  expected — pkm-5fak batches day references into that response, it doesn't
  change how many journal-batch fetches occur.

## New pattern noticed

Could not confirm whether `/api/journal` bodies grew from carrying day
references: `perf.mjs` only captures `transferSize` in the cold-load scenario
(H), not run here (scope was B, E, I), and scenario I's counters have no
byte-size field. Confirming it would need a manual `curl -w
'%{size_download}'` or an H run — out of scope for this pass.

## Files

`results.json` (perf.mjs, B/E/E2/I) and `ws-probe.json` (dead/flapping-link
reconnect accounting) sit alongside this report.
