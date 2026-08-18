---
# pkm-wvvu
title: Implementation quality follow-ups from 2026-08-17 reviews
status: completed
type: epic
priority: high
tags:
    - review
    - architecture
created_at: 2026-08-17T20:54:48Z
updated_at: 2026-08-18T20:15:49Z
---

## Context

The read-only backend and frontend implementation reviews completed on 2026-08-17 found a healthy codebase with a bounded set of invariant-deduplication, lifecycle, complexity, dead-code, and React-idiom follow-ups. No fixes were made by the reviews.

Sources:

- `docs/2026-08-17-implementation-review-backend.md`
- `docs/2026-08-17-implementation-review-frontend.md`

This epic owns all confirmed work from both reviews. Child beans group findings by cohesive implementation boundary rather than creating one issue per observation.

## Working agreement

- [x] Complete the high-priority invariant and lifecycle children first
- [x] Use red-green-refactor for behavior changes and regression fixes
- [x] Preserve server/replica parity where the same invariant exists on both sides
- [x] Update the relevant `docs/architecture/` owner when a boundary or invariant changes
- [x] Run focused verification for every child and the full server/web gates before completing the epic
- [x] Complete every child bean or explicitly record why it was scrapped or deferred

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

## Status note (2026-08-18, frontend slice)

All six normal-priority frontend children are completed and merged to main at 55c7be1: pkm-3lqg, pkm-nqve, pkm-d5re, pkm-2i6a, pkm-jk21, pkm-nvxh (four --no-ff lane merges: 4e29f97, 2787f0b, 6a7e704, 55c7be1). Full web verify green after every merge. Whole-branch review: no Critical/Important findings. Review-deferred follow-ups filed as pkm-ub5s (frontend deferred minors) and pkm-a4wf (applyOps other-page clone).

## Summary of Changes

All children closed. The final low-priority review sweep (2026-08-18) landed the last eight children — pkm-b2wb, pkm-mutr, pkm-a4wf, pkm-ij2s, pkm-nny1, pkm-kk0t, pkm-vpvf, pkm-ub5s — each on its own --no-ff-merged branch from an isolated worktree. Combined verification on the merged tree: server 1595 passed at 97.31% coverage plus pyrefly/ruff clean; web pnpm verify green end to end (2281 unit tests, 54 Playwright e2e) including the concurrently merged pkm-tu5k discard-intent work.
