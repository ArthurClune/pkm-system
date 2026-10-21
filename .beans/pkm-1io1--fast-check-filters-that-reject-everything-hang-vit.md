---
# pkm-1io1
title: fast-check filters that reject everything hang vitest workers, orphans block perf
status: completed
type: bug
priority: normal
created_at: 2026-10-21T14:29:32Z
updated_at: 2026-10-21T14:54:39Z
---

A fast-check `.filter` over a generator that can reject every value loops forever inside one run's generation. The loop is synchronous, so vitest's test timeout cannot interrupt it: the worker spins at 100% CPU. When the run that started it is abandoned (an agent moves on, a parent is killed), the `node (vitest)` workers are orphaned and keep spinning.

Seen during pkm-e7z9: five orphaned workers from a worktree's development runs held the 1-min load above 5 for over 30 minutes. `perf/check.sh` refused twice with only "machine busy", which reads as other sessions' load, not as stale processes of your own. The committed pkm-e7z9 tests no longer have such a filter (they `.map` to a fallback). Nothing stops the next property test from reintroducing one. The link from these workers to the `.filter` loop is inferred from their worktree and start times, not confirmed per process.

## Checklist

- [x] Confirm the mechanism: a minimal property whose arbitrary `.filter`s out every value hangs `pnpm test:unit` past the test timeout. Check whether killing the vitest parent (SIGTERM, SIGKILL, Ctrl-C) leaves the worker running, under the pool vitest uses here.
- [x] Make the trap fail loudly instead of hanging. Pick after checking what fast-check 4 and vitest offer:
  - a lint rule (in `pnpm lint`, with a teeth fixture) on property tests and arbitraries modules (`*.props.test.ts(x)`, `*Arbs.ts`, `web/src/props/**`): `.filter` on an arbitrary is refused in favour of `.map` with a fallback or `fc.pre`, with a declared, enforced escape for a filter that provably cannot reject everything (never an allow-list);
  - and/or a runtime guard, if fast-check exposes a generation hook or a cap on filter retries, set once in `src/test-setup.ts`.
- [x] Make orphans die: if killing the parent leaves workers behind, find the vitest setting or wrapper (pool choice, `teardownTimeout`, a parent-death check) that ends them.
- [x] `perf/check.sh` busy refusal: when it refuses for load, print the top CPU processes, and flag `node (vitest)` or `pytest` processes whose cwd is under the caller's checkout or its `.claude/worktrees/`, so stale processes of your own are named rather than read as someone else's load. Keep the refusal itself unchanged (never suggest `--allow-busy`).
- [x] The same busy check exists in `proptest/check.sh`? If so, give it the same diagnostic.
- [x] Document the trap and the guard in `docs/architecture/property-checks.md` (or `enforced-checks.md` if it becomes a lint), and add a row to `docs/troubleshooting.md` keyed by the symptom ("perf/check.sh says the machine is busy for a long time").

## Summary of Changes

- **Mechanism confirmed.** `fc.integer().filter(() => false)` in a 2 s test spun one worker at 100% CPU for 40 s with no output. fast-check 4.10's `FilterArbitrary.generate` is a bare `while (true)`. Under the forks pool, SIGTERM or SIGKILL to the vitest parent alone orphans the busy worker (reparented to pid 1); Ctrl-C (SIGINT to the group) kills everything. vitest's worker exits on SIGTERM and on IPC close through JS handlers, which never run while the main thread spins.
- **Trap fails loudly: runtime guard, not lint.** fast-check has no generation hook (4.10's `installGlobalPlugin` wraps only the predicate) and no retry cap, so `src/fcFilterCap.ts` replaces `Arbitrary.prototype.filter` with `CappedFilterArbitrary`, built on the public custom-arbitrary API, which throws after `MAX_FILTER_REJECTIONS` (10,000) draws in a row. It catches the failure wherever the filter lives, with no escape hatch needed for good filters. Its `value is T` predicate needed `fcFilterCap.ts` in `OPT_OUT_FILES`.
- **Shared setup.** `src/test-guards.ts` is the setup file for both `vite.config.ts` and `vitest.props.config.ts`. `src/test-setup.ts` would have missed the property suite, which ran with `setupFiles: []`.
- **Orphans die.** `src/orphanWatchdog.ts` starts a worker thread that SIGKILLs the process once `process.ppid` changes, the same approach as proptest's `sync_server._watch_parent`. Teeth: `tooling/orphanWatchdog.test.ts` SIGKILLs a real vitest parent over a spinning fixture.
- **perf busy refusal.** `MachineBusy` messages now list the `BUSY_TOP` busiest processes (`run_core.parse_ps`/`busy_report`). Each vitest/pytest process whose cwd is under the main checkout is flagged, and orphaned when its ppid is 1. The refusal text is unchanged. A live run caught that macOS pads retitled processes, which the first parser dropped.
- **proptest/check.sh** has no load check, so there was nothing to add.
- **Docs:** enforced-checks (filter cap row, `TEST_CODE` list), frontend (testing), property-checks (props config row), performance-checks (Machine load), troubleshooting row.
