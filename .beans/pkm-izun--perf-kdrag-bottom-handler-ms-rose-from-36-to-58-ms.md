---
# pkm-izun
title: Perf K/drag-bottom handler_ms rose from 36 to 58 ms between 5be15b5c and 592cb35
status: completed
type: task
priority: low
created_at: 2026-11-17T22:56:44Z
updated_at: 2026-11-18T14:55:34Z
---

The frontend perf baseline recorded K/drag-bottom handler_ms = 36.3 at 5be15b5c (Chromium 149). On 2026-11-17, on a quiet machine, two 5-run baselines at 592cb35 gave 57.9 ms with Chromium 149 (Playwright 1.61) and 58.7 ms with Chromium 159 (Playwright 1.65). So the rise is not the browser: it came in on main between those commits. It stays inside the gate's tolerance (TIMING_FACTOR 2x in server/tooling/perfcheck/compare.py), so perf/check.sh reported 'no changes' on main; it had read stale-baseline on a busy machine. The other timings and every count matched.

The Playwright 1.65 branch (pkm-kyle) rebaselined to 58.7, so a later check will not show this rise again.

Candidates among the merges in the range: 4689d4d2 (perf harness: fixture db_generation, branch-new scenarios at the merge base, optimized fixture FTS) and b7133ef6 (the synthetic graph gained queries, tables and templates) can change what K drags over without any product change; DnD-related product changes are the other suspects.

- [x] Bisect the merges between 5be15b5c and 592cb35 on the K scenario
- [x] Decide: fixture change (accept, note it) or product regression (fix)

## Summary of Changes

No regression, in the product or the fixture: the 36.3 ms baseline was a low outlier.

The bisect measured K with one harness and fixture (main at 05ba5485, Chromium 159) against each commit's own web and server code, five runs each, median handler_ms for drag-bottom / drag-top:

| commit | drag-bottom | drag-top |
|---|---|---|
| 5be15b5c | 43.2 (33.9 to 59.3) | 20.4 |
| 4689d4d2 | 61.0 | 22.5 |
| 62da114d | 59.5 | 24.6 |
| d752da19 | 57.3 | 22.0 |
| 1ac7b298 | 58.3 | 21.2 |
| 592cb359 | 61.2 | 22.0 |

5be15b5c and 4689d4d2 have identical trees apart from perf/baseline-frontend.json, so the same code reads anywhere from 34 to 61 ms. Every frontend baseline since 2026-09-26 recorded K/drag-bottom between 54 and 68 ms, except b7f14e96 (rebaseline at 06cd655 for fixture hash f36fe685), which recorded 36.3. The next baseline on that same fixture hash recorded 58.7. So 36.3 was a run that landed in drag-bottom's occasional fast mode, which the 5be15b5c run above also shows (33.9 and 39.2 among its five readings).

Nothing to fix, and the current baseline (53.9) is in the usual range. The bimodal drag-bottom reading is harness noise that the 2x timing tolerance absorbs; its cause is not investigated here.
