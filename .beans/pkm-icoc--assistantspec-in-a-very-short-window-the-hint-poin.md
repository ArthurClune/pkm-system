---
# pkm-icoc
title: assistant.spec 'in a very short window the hint points up to the end it passed' fails 2 in 8 run alone
status: completed
type: bug
priority: normal
created_at: 2026-11-17T22:05:08Z
updated_at: 2026-11-18T10:53:03Z
---

Symptom: e2e/assistant.spec.ts, test 'in a very short window the hint points up to the end it passed', fails at the final expect.poll with 'Timeout 5000ms exceeded while waiting on the predicate' (Expected: true, Received: false): Allow never enables.

Reproduced 2026-11-17 at main 0eed7c61 (and on the katex 0.19 branch): node tooling/runPlaywright.ts e2e/assistant.spec.ts -g 'very short window' --repeat-each 8 gives 6 passed, 2 failed, run alone, on a machine with a game running (load ~3-5). It also failed once in a full pnpm verify.

Hypothesis to test first: the poll scrolls the transcript up 8px per attempt, and expect.poll's backing-off intervals give only about eight attempts in 5s, so the test can reach the end marker only if it sits within ~60px; under load fewer attempts run. If so, the fix is in the spec (scroll until the marker is in view, then poll Allow). Rule out a product bug first: that the end marker's visibility observer misses a marker that does pass through view (AGENTS.md: a spec that fails alone is a suspected product bug).

- [x] Find whether the marker ever entered the transcript's viewport in a failing run
- [x] Fix the product or the spec accordingly
- [x] --repeat-each 20 run alone passes

## Summary of Changes

Spec bug, not a product bug. Instrumenting the poll showed every run needs
7-8 steps of 8px (about 48px) before the end marker enters view; Allow then
arms on that same step and the hint clears. expect.poll's default backoff
(100, 250, 500, then 1000 ms) puts the 7th-8th attempt at 4-4.9 s of its 5 s
timeout, so any delay failed the test. The poll now runs at a fixed 50 ms
interval with the same 8px steps (small steps keep the marker passing through
view rather than being jumped over). 20 of 20 alone, about 0.8 s each instead
of 4-5 s; pnpm verify green.
