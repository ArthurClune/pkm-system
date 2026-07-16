---
# pkm-c1cg
title: Web architecture and FCIS hardening from 2026-07-15 review
status: completed
type: epic
priority: high
tags:
    - web
    - architecture
    - fcis
created_at: 2026-07-15T14:22:26Z
updated_at: 2026-07-16T12:09:24Z
---

## Goal

Address the correctness, complexity, design, maintainability, and FCIS findings from the 2026-07-15 web/TypeScript architecture review.

## Scope

- Eliminate identified offline-sync and outline reconciliation data-integrity risks.
- Make editor and sync orchestration easier to reason about and test.
- Restore semantic FCIS compliance and enforce it automatically.
- Standardize async UI behavior, worker lifecycle, parsing, linting, and bundle guardrails.

## Completion criteria

- [x] All critical and high-priority child beans are completed.
- [x] Remaining normal-priority child beans are completed or explicitly deferred with rationale.
- [x] New concurrency and rerender regressions are covered by focused tests.
- [x] The canonical web verification suite passes.
- [x] Architecture documentation reflects the resulting boundaries.

## Child roadmap

- [x] 1. pkm-qvqz — Make replica recovery atomic with concurrent enqueues
- [x] 2. pkm-huv4 — Reconcile optimistic state after server-rejected batches
- [x] 3. pkm-z77x — Prevent outline refetches from overwriting or discarding newer state
- [x] 4. pkm-viah — Eliminate simultaneous same-title editor divergence
- [x] 5. pkm-wudz — Extract pure editor and sync state machines from large shells
- [x] 6. pkm-1jw6 — Correct and enforce TypeScript FCIS boundaries
- [x] 7. pkm-stn6 — Standardize async UI request and mutation lifecycles
- [x] 8. pkm-dcmm — Own replica worker lifecycle and clarify queue idle semantics
- [x] 9. pkm-1cq3 — Consolidate reference and TODO grammar scanning
- [x] 10. pkm-f1rn — Add web lint, FCIS checks, and bundle/precache budgets

## Execution

- Consolidated design: `docs/superpowers/specs/2026-07-15-web-architecture-fcis-hardening-design.md`.
- Scope decision: complete all ten child beans; none deferred.
- Delivery: isolated epic branch with one fresh implementer and independent reviewer per child.

## Implementation Plan

- Plan: `docs/superpowers/plans/2026-07-15-web-architecture-fcis-hardening.md`.
- Sequence: lifecycle contracts → atomic recovery → poison repair → title ownership → outline reconciliation → async UI → pure state extraction → grammar scanner → FCIS enforcement → lint/budgets → final audit.

## Summary of Changes

All ten children completed, each with a fresh implementer, an independent
task-scoped review (all Approved with no Critical/Important findings), and
canonical verification at its head. Child commits on
feat/pkm-c1cg-web-architecture (base bc88a9f):

- Task 1 pkm-dcmm ef5e55d..7eadae5 — worker lifecycle and queue completion contracts
- Task 2 pkm-qvqz 9cc2a2b..79bd85f — atomic replica recovery gate
- Task 3 pkm-huv4 2abd159..17716b2 — authoritative repair after rejected batches
- Task 4 pkm-viah fde798b..3b42b2b — atomic same-title editor ownership
- Task 5 pkm-z77x 0afc421..405a5e3 — versioned outline reconciliation
- Task 6 pkm-stn6 b5c6351..7a2c1ff — standardized async UI lifecycles
- Task 7 pkm-wudz f22ab39..261f1fc — pure editor/sync state cores (keyboardPolicy,
  queueState, syncState, outlineState extensions); replicaSync deliberately
  remains a shell (reviewer-adjudicated)
- Task 8 pkm-1cq3 9691df0 — shared grammar scanner (scanGrammar) with thin adapters
- Task 9 pkm-1jw6 503d99f — semantic FCIS boundaries + compiler-API checker (check:fcis)
- Task 10 pkm-f1rn 3b9ff69 — flat type-aware ESLint, bundle/precache budgets,
  zero exhaustive-deps suppressions; initialEntryBytes 462016 user-ratified
- Task 11 16b4368 — architecture docs (docs/design.md web-architecture section)

Final whole-branch review (bc88a9f..fccd51b, most capable model, with
queue/sync and grammar/FCIS seam audits): READY TO MERGE — zero Critical or
Important findings; five Minors triaged (three folded into follow-up bean
pkm-wggr, output hygiene into pkm-23dd, rest accepted with rationale in
.superpowers/sdd/progress.md).

Canonical verification at fccd51b: typecheck, ESLint 0 issues, check:fcis
101 modules 0 violations, 80 unit files / 1021 tests, coverage 97.85%
stmts / 92.25% branches / 95.62% funcs / 97.85% lines (thresholds 95/91/89),
guarded build budgets all OK (initialEntryBytes 440910/462016, precacheBytes
5273425/5494604, precacheEntries 74 guard / 78 final / 82 cap,
mermaidOwnedBytes within 3461961), Playwright 7/7 against the guarded dist.
Server suite: 395 passed, 95.72% coverage.

Architecture documentation: docs/design.md ("Web client architecture — sync,
outline, and FCIS hardening" section); spec §10 amended with the ratified
entry budget.
