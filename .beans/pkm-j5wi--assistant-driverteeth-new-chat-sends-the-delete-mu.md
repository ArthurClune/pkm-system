---
# pkm-j5wi
title: 'assistant driverTeeth: ''New chat sends the DELETE'' mutant caught by the wrong rule under a full web proptest run'
status: todo
type: bug
priority: normal
created_at: 2026-11-12T17:25:07Z
updated_at: 2026-11-12T17:40:36Z
---

In a full `proptest/check.sh web` run on 2026-11-12, `src/props/assistant/driverTeeth.prop.ts` failed one test:

`× the assistant driver property catches: New chat sends the DELETE before the aborted stream settles` → `mutant caught, but not by delete (seed -1934688392): ... quiet: still outstanding after settling: , 2 timers, 0 409s: expected false to be true`

The same suite passes alone at both 3cfc7d41 and the pkm-3ono branch head, and replaying `--seed -1934688392` passes on both. So it depends on load or timing in the full run (fake timers left outstanding), not on the drawn commands. Per AGENTS.md, a property that fails and then passes on the same seed gets a bean against the gate.

- [ ] Reproduce under load (full web run, or the suite beside a CPU-heavy one)
- [ ] Find why two timers are still outstanding at the quiet check
- [ ] Fix the harness or the rule, with the reason in the commit

## Another occurrence (2026-11-12)

Full web run from the 3kwx-stall-behind-poison worktree: assistant/driverTeeth.prop.ts 'an old stream's event is dispatched for the turn busy when it arrives' -> mutant caught, but not by agree (seed -759678055). Rerun on that seed: 15/15 pass. Same pattern as above, a different test.
