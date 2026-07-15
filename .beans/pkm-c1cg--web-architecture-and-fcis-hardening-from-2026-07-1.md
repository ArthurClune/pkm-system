---
# pkm-c1cg
title: Web architecture and FCIS hardening from 2026-07-15 review
status: in-progress
type: epic
priority: high
tags:
    - web
    - architecture
    - fcis
created_at: 2026-07-15T14:22:26Z
updated_at: 2026-07-15T14:23:27Z
---

## Goal

Address the correctness, complexity, design, maintainability, and FCIS findings from the 2026-07-15 web/TypeScript architecture review.

## Scope

- Eliminate identified offline-sync and outline reconciliation data-integrity risks.
- Make editor and sync orchestration easier to reason about and test.
- Restore semantic FCIS compliance and enforce it automatically.
- Standardize async UI behavior, worker lifecycle, parsing, linting, and bundle guardrails.

## Completion criteria

- [ ] All critical and high-priority child beans are completed.
- [ ] Remaining normal-priority child beans are completed or explicitly deferred with rationale.
- [ ] New concurrency and rerender regressions are covered by focused tests.
- [ ] The canonical web verification suite passes.
- [ ] Architecture documentation reflects the resulting boundaries.

## Child roadmap

- [ ] 1. pkm-qvqz — Make replica recovery atomic with concurrent enqueues
- [ ] 2. pkm-huv4 — Reconcile optimistic state after server-rejected batches
- [ ] 3. pkm-z77x — Prevent outline refetches from overwriting or discarding newer state
- [ ] 4. pkm-viah — Eliminate simultaneous same-title editor divergence
- [ ] 5. pkm-wudz — Extract pure editor and sync state machines from large shells
- [ ] 6. pkm-1jw6 — Correct and enforce TypeScript FCIS boundaries
- [ ] 7. pkm-stn6 — Standardize async UI request and mutation lifecycles
- [ ] 8. pkm-dcmm — Own replica worker lifecycle and clarify queue idle semantics
- [ ] 9. pkm-1cq3 — Consolidate reference and TODO grammar scanning
- [ ] 10. pkm-f1rn — Add web lint, FCIS checks, and bundle/precache budgets
