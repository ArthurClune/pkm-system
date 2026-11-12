---
# pkm-mgc0
title: Full web proptest run stalls after src/props/sync/bannerTeeth.prop.ts output
status: todo
type: bug
priority: normal
created_at: 2026-11-12T17:25:07Z
updated_at: 2026-11-12T17:33:23Z
---

Two full `proptest/check.sh web` runs on 2026-11-12 stalled with the vitest worker at 0% CPU and no further output. One was from the 3kwx-stall-behind-poison worktree, which held port 8978 for over an hour, and the other was on the pkm-3ono branch head. In the pkm-3ono run the last output was a stdout line from `src/props/sync/bannerTeeth.prop.ts` (teeth banner pausedDropped), with these suites not yet reported: backlinks/teeth, backlinks/unlinkedTeeth, files/teeth, journal/teeth, outline/draft, outline/draftTeeth, outline/imeTeeth, outline/teeth, sync/smoke, sync/sync.

Every one of those suites, and bannerTeeth itself, passes alone with `--file`, at both 3cfc7d41 and the branch head. So the stall needs the full run: the suite order, shared module state across files in one worker, or a pending fake timer left by an earlier suite.

The gate has no per-suite time limit, so a stalled run never reports a result and holds its port until someone kills it by hand. Since PROPTEST_PORT (pkm-fgbk), parallel sessions can run the web gate on their own ports, so a stall only blocks others still on the default 8978; the run that stalls still gets no verdict.

- [ ] Reproduce with a full run, and find which file is executing when the worker idles
- [ ] Fix the cause
- [ ] Consider a per-suite or overall deadline in proptest/run.py, so a stall fails the gate instead of holding the port
