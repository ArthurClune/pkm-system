---
# pkm-icoc
title: assistant.spec 'in a very short window the hint points up to the end it passed' fails 2 in 8 run alone
status: todo
type: bug
priority: normal
created_at: 2026-11-17T22:05:08Z
updated_at: 2026-11-17T22:05:08Z
---

Symptom: e2e/assistant.spec.ts, test 'in a very short window the hint points up to the end it passed', fails at the final expect.poll with 'Timeout 5000ms exceeded while waiting on the predicate' (Expected: true, Received: false): Allow never enables.

Reproduced 2026-11-17 at main 0eed7c61 (and on the katex 0.19 branch): node tooling/runPlaywright.ts e2e/assistant.spec.ts -g 'very short window' --repeat-each 8 gives 6 passed, 2 failed, run alone, on a machine with a game running (load ~3-5). It also failed once in a full pnpm verify.

Hypothesis to test first: the poll scrolls the transcript up 8px per attempt, and expect.poll's backing-off intervals give only about eight attempts in 5s, so the test can reach the end marker only if it sits within ~60px; under load fewer attempts run. If so, the fix is in the spec (scroll until the marker is in view, then poll Allow). Rule out a product bug first: that the end marker's visibility observer misses a marker that does pass through view (AGENTS.md: a spec that fails alone is a suspected product bug).

- [ ] Find whether the marker ever entered the transcript's viewport in a failing run
- [ ] Fix the product or the spec accordingly
- [ ] --repeat-each 20 run alone passes
