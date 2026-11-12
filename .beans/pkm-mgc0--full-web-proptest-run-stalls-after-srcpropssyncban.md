---
# pkm-mgc0
title: Full web proptest run stalls after src/props/sync/bannerTeeth.prop.ts output
status: completed
type: bug
priority: normal
created_at: 2026-11-12T17:25:07Z
updated_at: 2026-11-12T20:13:52Z
---

Two full `proptest/check.sh web` runs on 2026-11-12 stalled with the vitest worker at 0% CPU and no further output. One was from the 3kwx-stall-behind-poison worktree, which held port 8978 for over an hour, and the other was on the pkm-3ono branch head. In the pkm-3ono run the last output was a stdout line from `src/props/sync/bannerTeeth.prop.ts` (teeth banner pausedDropped), with these suites not yet reported: backlinks/teeth, backlinks/unlinkedTeeth, files/teeth, journal/teeth, outline/draft, outline/draftTeeth, outline/imeTeeth, outline/teeth, sync/smoke, sync/sync.

Every one of those suites, and bannerTeeth itself, passes alone with `--file`, at both 3cfc7d41 and the branch head. So the stall needs the full run: the suite order, shared module state across files in one worker, or a pending fake timer left by an earlier suite.

The gate has no per-suite time limit, so a stalled run never reports a result and holds its port until someone kills it by hand. Since PROPTEST_PORT (pkm-fgbk), parallel sessions can run the web gate on their own ports, so a stall only blocks others still on the default 8978; the run that stalls still gets no verdict.

- [x] Reproduce with a full run, and find which file is executing when the worker idles
- [x] Fix the cause
- [x] Consider a per-suite or overall deadline in proptest/run.py, so a stall fails the gate instead of holding the port

## Narrowed (2026-11-12, from the 3kwx worktree's stall)

That run's log also ends right after "teeth banner pausedDropped", and each bannerTeeth catch test logs its line when it finishes, so the worker was idle inside the next scenario, keptReplaced (BadBatch fails, AwaitBanner, WorkerDies, Pull), in its clean or its catch test. The vitest worker and the sync server both sat at 0 CPU for 20 minutes: a request that never settles fits. Of bannerTeeth's commands only AwaitBanner has a time limit, so a stuck command waits for vitest's 20-minute testTimeout. Not reproduced: 20 back-to-back runs of bannerTeeth.prop.ts on their own port (60 s cap each) and the full src/props/sync run all passed.

- [x] Give each bannerTeeth scenario a time limit that fails with its command list, so the next stall names its step

## Summary of Changes

Reproduced on a full run (2026-11-12): the log ended after 'teeth banner pausedDropped' with the worker and server idle. Through the inspector, the stalled worker's globalThis.setTimeout was a fake-timers clock that had been uninstalled (clearTimeout and Date were real again, methods []), with every pending timer (undici's, the replica RPC timeouts, the 5 ms AwaitBanner polls, vitest's own) parked on it. No timer could fire, so even the 20-minute testTimeout never came.

Cause: driverTeeth's mutant 'the stop's fallback waits twice STOP_ACK_TIMEOUT_MS' wrapped the fake setTimeout with vi.spyOn. @vitest/spy keeps every spy in a module-level set, and with singleFork vitest calls vi.restoreAllMocks() after each file, which restored those spies again and wrote the dead clock's fake setTimeout back onto globalThis. Every later file in the shared process lost its timers; whether a timer-dependent suite came after driverTeeth depends on the sequencer's order, hence intermittent. Reproduced deterministically with driverTeeth and a probe file in one process.

Fixes:
- The mutant swaps globalThis.setTimeout by hand (web/src/props/assistant/driverTeeth.prop.ts).
- vitest.props.config.ts runs each props file in a fresh process (fileParallelism: false, no singleFork), so no file inherits another's leftovers. Rule stated in docs/architecture/checks.md § Property gate.
- bannerTeeth scenarios fail after SCENARIO_LIMIT_MS, naming the step, the banner, and what the client waits on (new Transport.waiting()).
- proptest/run.py kills the web run at WEB_DEADLINE_S (whole process group) and fails the gate instead of holding the port; tests in server/tests/test_proptest_sides.py.

Full web gate after the fixes: 8 min 31 s, no stall.
