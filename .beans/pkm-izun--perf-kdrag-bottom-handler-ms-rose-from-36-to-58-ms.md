---
# pkm-izun
title: Perf K/drag-bottom handler_ms rose from 36 to 58 ms between 5be15b5c and 592cb35
status: todo
type: task
priority: low
created_at: 2026-11-17T22:56:44Z
updated_at: 2026-11-17T22:56:44Z
---

The frontend perf baseline recorded K/drag-bottom handler_ms = 36.3 at 5be15b5c (Chromium 149). On 2026-11-17, on a quiet machine, two 5-run baselines at 592cb35 gave 57.9 ms with Chromium 149 (Playwright 1.61) and 58.7 ms with Chromium 159 (Playwright 1.65). So the rise is not the browser: it came in on main between those commits. It stays inside the gate's tolerance (TIMING_FACTOR 2x in server/tooling/perfcheck/compare.py), so perf/check.sh reported 'no changes' on main; it had read stale-baseline on a busy machine. The other timings and every count matched.

The Playwright 1.65 branch (pkm-kyle) rebaselined to 58.7, so a later check will not show this rise again.

Candidates among the merges in the range: 4689d4d2 (perf harness: fixture db_generation, branch-new scenarios at the merge base, optimized fixture FTS) and b7133ef6 (the synthetic graph gained queries, tables and templates) can change what K drags over without any product change; DnD-related product changes are the other suspects.

- [ ] Bisect the merges between 5be15b5c and 592cb35 on the K scenario
- [ ] Decide: fixture change (accept, note it) or product regression (fix)
