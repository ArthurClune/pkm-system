---
# pkm-nqve
title: Share replica recovery lifecycles and tighten reset contracts
status: in-progress
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:23Z
updated_at: 2026-08-18T16:25:09Z
parent: pkm-wvvu
---

## Review findings

Frontend A5 recovery half. `resetLocalData` reimplements `runRecovery` prepare, flush, snapshot, commit, and resume lease handling with small deltas, so lifecycle fixes can drift.

## Acceptance criteria

- [ ] Extract a shared recovery-lease protocol or extend `runRecovery` with explicit reset options
- [ ] Represent `ResetBlockedError`, started-state, and forced-ready differences as named options or results rather than duplicated control flow
- [ ] Guarantee resume/finalization on every success, failure, and cancellation path
- [ ] Preserve pending operations and availability state according to current recovery policy
- [ ] Add deterministic tests for reset, recovery, blocked reset, snapshot failure, commit failure, and cleanup ordering
- [ ] Update sync-and-offline architecture documentation
