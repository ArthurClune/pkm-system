---
# pkm-3lqg
title: Unify BacklinksSection pagination and state updates
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

Frontend A4. Initial load and refresh independently implement the same batched fetch, merge, epoch guard, and no-growth termination loop, while three coupled values are maintained in separate state updates.

## Acceptance criteria

- [ ] Extract one tested backlink batch-walk used by initial load and refresh
- [ ] Keep epoch/supersession checks at every asynchronous boundary
- [ ] Store groups, total page count, and extra reference texts as one atomic state value
- [ ] Preserve incremental pagination, deduplication, ordering, refresh, and no-growth termination
- [ ] Add tests for stale refreshes, multi-batch results, duplicates, and partial failures
