---
# pkm-wvvu
title: Implementation quality follow-ups from 2026-08-17 reviews
status: todo
type: epic
priority: high
tags:
    - review
    - architecture
created_at: 2026-08-17T20:54:48Z
updated_at: 2026-08-17T20:55:25Z
---

## Context

The read-only backend and frontend implementation reviews completed on 2026-08-17 found a healthy codebase with a bounded set of invariant-deduplication, lifecycle, complexity, dead-code, and React-idiom follow-ups. No fixes were made by the reviews.

Sources:

- `docs/2026-08-17-implementation-review-backend.md`
- `docs/2026-08-17-implementation-review-frontend.md`

This epic owns all confirmed work from both reviews. Child beans group findings by cohesive implementation boundary rather than creating one issue per observation.

## Working agreement

- [ ] Complete the high-priority invariant and lifecycle children first
- [ ] Use red-green-refactor for behavior changes and regression fixes
- [ ] Preserve server/replica parity where the same invariant exists on both sides
- [ ] Update the relevant `docs/architecture/` owner when a boundary or invariant changes
- [ ] Run focused verification for every child and the full server/web gates before completing the epic
- [ ] Complete every child bean or explicitly record why it was scrapped or deferred

## Completion

The epic is complete only when every child has a terminal status, all retained acceptance criteria are satisfied, architecture documentation reflects the final boundaries, and combined verification is green.

## Child beans

### High priority

- `pkm-6g0l` — backend asset verification and staging
- `pkm-t3qw` — cross-stack reference reindexing
- `pkm-f3mo` — deterministic assistant/SSE teardown
- `pkm-w5gf` — retire legacy frontend queue compatibility

### Normal priority

- `pkm-byig` — backend query execution/grouping
- `pkm-9w4f` — title-span API and importer sanitization
- `pkm-2771` — CLI/client/shared package boundaries
- `pkm-2i6a` — shared popover/dismissal behavior
- `pkm-jk21` — explicit outline loader/replay policies
- `pkm-3lqg` — BacklinksSection pagination/state
- `pkm-nqve` — replica recovery/reset lifecycle
- `pkm-d5re` — visible TopBar deletion failures
- `pkm-nvxh` — outline render hot paths

### Low priority

- `pkm-b2wb` — backend minor cleanup/documentation
- `pkm-kk0t` — shared React idiom hooks
- `pkm-nny1` — outline session decomposition
- `pkm-ij2s` — SyncProvider and repair UI decomposition
- `pkm-vpvf` — frontend minor cleanup/documentation
