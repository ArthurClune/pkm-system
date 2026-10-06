---
# pkm-c1hj
title: 'Perf harness: W/warm first_outline_ms flagged unstable under concurrent test load'
status: completed
type: bug
priority: low
created_at: 2026-10-01T13:30:00Z
updated_at: 2026-10-06T11:39:41Z
---

perf/check.sh frontend reported W/warm first_outline_ms as unstable (baseline 206 ms, now 582 ms) on 2026-10-01 while checking the pkm-iskx branch (web brand types only, no runtime change on the outline path). Another worktree's server and web test suites were running on the machine at the same time. On the same day, the pkm-he87 check under similar load reported K/drag-bottom and K/drag-top handler_ms as 'improvements' (55.9 -> 24.2 ms, 16.5 -> 6.5 ms), and the rewritten baseline was discarded.

Question: does the harness detect a loaded machine, and should it refuse to run or retry, rather than report unstable or improved timings (and rewrite baselines on an improvement)?

- [x] Reproduce: run perf/check.sh frontend on main twice, once idle and once with a pnpm verify running in another worktree
- [x] Decide: a load check (os.loadavg or a calibration probe) that warns or refuses, and/or no baseline rewrite on improvements when variance is high
- [x] Implement and document in docs/architecture/performance-checks.md


## Reproduction (2026-10-06, main at d3d50149, 10-core Mac)

| Run | Load (1-min, start→end) | W first_outline_ms | K/drag-top handler_ms | K/drag-bottom handler_ms | Verdict |
|---|---|---|---|---|---|
| idle | ~1.5 → ~2.2 | 215 | 17.4 | 58.6 | no changes |
| 10× `yes` burners | 5.6 → 14.7 | 271 | 2.4 | 22.3 | K "improvement" ×2, **passed and rewrote the baseline** (reverted) |
| idle (load sampled every 5 s) | 8.6 decaying → 2.2 | 210 | 15.8 | 49.4 | no changes |

K paces 120 dragovers 16 ms apart: on an idle machine the core clocks down between events, so each handler runs slow; under full load the cores stay clocked up and the handler is 2.5–7× faster. Load moves timings both ways, so a one-run timing ratchet is as untrustworthy as a one-run regression, and a ratcheted K baseline makes the next idle run fail as stale-baseline. The 1-min load average lags: it took ~2 min to decay from 8.6 to the check's own ~2.2 after the load stopped.

## Decision (Arthur, 2026-10-06)

1. A check no longer lowers a timing baseline. A timing that beats its baseline by TIMING_FACTOR is reported (verdict `faster`, not failing) and the baseline keeps its value; `--bootstrap` (median of runs) is the only way to lower it.
2. A busy machine refuses to run: before measuring each side, wait a bounded time for the 1-min load average to fall below half the cores, then exit 2 if it hasn't; after measuring, refuse (exit 2, nothing written) if it rose during the run. `--allow-busy` overrides. Applies to checks and to `--bootstrap`/`--rebaseline`.


## Summary of Changes

- `compare._judge`: a timing that beats its baseline by TIMING_FACTOR is the new non-failing kind `faster`; the baseline keeps its value, and `run_core._NEXT` says to `--bootstrap` on a quiet machine if the gain is real. Exact and band ratchets are unchanged.
- `run.wait_until_quiet` (before each side measures) waits up to LOAD_WAIT_S for the 1-min load to fall to BUSY_LOAD_PER_CPU per core, then raises `MachineBusy` (exit 2); `run.ensure_still_quiet` (after measuring, before any write) refuses if it rose. Both apply to checks, `--bootstrap` and `--rebaseline`; `--allow-busy` skips them. Every check report ends with a `load: start → end` line.
- Live on the backend side: quiet run passes with `load: 2.0 → 2.1`; ten CPU burners held throughout → waited 3 min then exit 2; started just after the burners stopped (load 12.9) → waited ~1 min, then ran and passed.
- Docs: performance-checks.md § Machine load, the classes/verdicts/exit tables; AGENTS.md perf guidance; troubleshooting row.
