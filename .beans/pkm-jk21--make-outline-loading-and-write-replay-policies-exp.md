---
# pkm-jk21
title: Make outline loading and write-replay policies explicit and type-safe
status: todo
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:23Z
updated_at: 2026-08-17T20:55:23Z
parent: pkm-wvvu
---

## Review findings

Frontend A3, B2, B3, and the `transitionOutline` exhaustiveness observation.

The missing-daily-page policy is duplicated, write replay is optional despite being required for safe rebasing, and authoritative loader selection depends on last-mounted registration order.

## Acceptance criteria

- [ ] Route the registered loader missing-page case through `substituteMissingDaily`
- [ ] Remove the dead `write-started.ops` variant, require replay data, and eliminate the empty replay default
- [ ] Add tests that fail if local write tracking can erase a previously recorded replay
- [ ] Replace registration-order loader election with named loader kinds and explicit precedence
- [ ] Make outline transition handling compiler-exhaustive so new events cannot fall through as write settlement
- [ ] Preserve page/day loading, repair epochs, parent reads, and optimistic replay with focused race tests
- [ ] Document loader precedence and replay ownership in frontend/sync architecture
