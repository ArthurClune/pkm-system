---
# pkm-viah
title: Eliminate simultaneous same-title editor divergence
status: completed
type: bug
priority: high
tags:
    - web
    - outline
    - dnd
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T18:36:21Z
parent: pkm-c1cg
---

## Problem

Two same-title EditablePage instances mounted in one commit both observe no active owner and become editable. Their local state can diverge and the DnD registry is last-wins.

## Scope

Provide shared per-title outline state or atomic subscription-backed editor ownership, and make duplicate DnD registration safe.

## Acceptance criteria

- [x] Simultaneous same-title mounts cannot create independent editable states.
- [x] All views of one title observe the same local edits, or exactly one is atomically read-only.
- [x] DnD registration rejects duplicates or restores the prior owner safely.
- [x] The existing test that documents double ownership is replaced with the intended behavior.
- [x] Sequential sidebar/main-pane behavior remains covered.
- [x] pnpm verify passes.

## Summary of Changes

Same-title views now acquire one ref-counted session after commit, share every flushed tree, and contend for a single idempotent editor lease. Pending and fallback views remain inert while preserving stable block DOM; owner cleanup promotes the next live claimant. DnD registrations reject duplicates and use token-checked cleanup. Simultaneous, StrictMode, shared-flush, handoff, main/sidebar ordering, hash-scroll, canonical unit/build, and Playwright coverage pass.

## Independent review fix

Remote WebSocket reduction and cross-page authoritative reads are now session-owned rather than repeated by each same-title hook subscriber. Exact WsBatch object fanout is applied once, overlapping authoritative reads share one retryable single-flight promise, and shared adoption revalidates view-local focus. Deterministic once-only move/GET regressions, the expanded Task 4 matrix, canonical 743-test/build suite, and Playwright 6/6 pass.
