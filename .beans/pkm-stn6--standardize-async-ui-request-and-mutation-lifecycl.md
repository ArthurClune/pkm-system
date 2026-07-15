---
# pkm-stn6
title: Standardize async UI request and mutation lifecycles
status: todo
type: bug
priority: high
tags:
    - web
    - ui
    - concurrency
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T14:23:26Z
parent: pkm-c1cg
---

## Problem

Async UI components use inconsistent stale-response, rerender, and mutation-serialization patterns. Confirmed risks include stale QueryBlock responses, BlockTree collapse drift, stale Bluesky actor/height state, and overlapping SidebarNav mutations.

## Scope

Introduce consistent request sequencing or cancellation, prop-state reconciliation, and serialized mutation behavior across affected components.

## Acceptance criteria

- [ ] QueryBlock drops or aborts responses for obsolete expressions and pagination generations.
- [ ] BlockTree reconciles authoritative collapsed changes while preserving intentional view-only toggles.
- [ ] BlueskyEmbed derives actor state from the current href and resets post-specific height.
- [ ] SidebarNav serializes conflicting mutations, disables unsafe controls, and reports failures.
- [ ] Rerender and out-of-order-response tests cover each case.
- [ ] Reusable async helpers are introduced only where they reduce duplication.
- [ ] pnpm verify passes.
