---
# pkm-a4t2
title: Sync subsystem review follow-ups (2026-09-29)
status: todo
type: epic
priority: high
tags:
    - review
    - sync
created_at: 2026-09-29T13:20:16Z
updated_at: 2026-09-29T13:21:27Z
---

## Context

The consolidated adversarial review of the sync subsystem at `2a95e4a8`
(`docs/2026-09-29-sync-subsystem-review-consolidated.md`) confirmed four paths
that discard a user's text or a queued edit (F1 to F4), four convergence or
liveness defects (F5 to F8), an untyped ops ack, a documented UI gap (F9), and
docs and maintainability findings. This epic owns all confirmed work from it.

Design for every fix: `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md`.
Decisions recorded there (Arthur, 2026-09-29): the stale-delete gap is closed
by a hash-guarded delete (draft feature under this epic); the F9 memory-only
copy narrows pkm-0htf rather than reversing it; bean ids are banned from code
comments as they are from `docs/architecture/`.

## Working agreement

- [ ] F1 to F4 first, each independent; F6 after F1; F5 before the typed ack
- [ ] Red-green for every behaviour change; a fix ships its composed test and its doc correction in the same branch
- [ ] Comments in touched code state the rule and carry no bean id
- [ ] Route or contract changes run the regen checklist before review
- [ ] `perf/check.sh` per completed fix before merge; whole-branch review on the strongest model
- [ ] Every child reaches a terminal status or records why it was scrapped or deferred

## Completion

Complete when every child is terminal, the architecture docs reflect the
final guarantees (the "one transaction", "never erases intent" and "feed
tombstones the ghost" claims are true or gone), and combined verification is
green on the merged tree.

## Children

### High: preservation (F1 to F4)

- pkm-9xg0 — F1 durable-first file replacement
- pkm-gwwu — F2 one transaction in POST /api/ops
- pkm-impk — F3 draft base identity and keep-on-disappear
- pkm-jyx1 — F4 auth statuses are retry-later, not rejection

### Normal: convergence, contract, UI, tests, docs

- pkm-6xza — F5 skipped-ack refetch in every tab
- pkm-yvka — F6 acknowledged batches are never replayed (after pkm-9xg0)
- pkm-8uc9 — F7 reused page id as delete-then-create in the feed
- pkm-i35e — F8 repair ownership released on every exit
- pkm-jk1d — typed ops ack (after pkm-6xza)
- pkm-l3cr — F9 memory-only copy while offline
- pkm-rrzq — composed tests belonging to no fix
- pkm-xjew — docs corrections not tied to a fix; AGENTS.md comment rule

### Low: after the fixes

- pkm-9u3y — bean-id sweep in code comments
- pkm-xwb5 — web extraction pass (own spec when picked up)
- pkm-87w0 — server ops tidy and test hygiene

### Draft: own brainstorm

- pkm-nny8 — hash-guarded delete
