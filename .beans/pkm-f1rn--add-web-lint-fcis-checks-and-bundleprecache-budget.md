---
# pkm-f1rn
title: Add web lint, FCIS checks, and bundle/precache budgets
status: todo
type: task
priority: normal
tags:
    - web
    - tooling
    - performance
created_at: 2026-07-15T14:23:27Z
updated_at: 2026-07-15T14:23:27Z
parent: pkm-c1cg
---

## Goal

Add automated guardrails for React hook correctness, TypeScript maintainability, FCIS boundaries, and production/PWA asset size.

## Scope

Introduce TypeScript-aware linting, remove or justify hook dependency suppressions, and prevent Mermaid or other lazy chunks from silently inflating the PWA precache.

## Acceptance criteria

- [ ] A lint command enforces React Hooks and TypeScript promise/error rules.
- [ ] Existing exhaustive-deps suppressions are removed or documented with stable abstractions.
- [ ] FCIS classification and import-boundary checks run in verification.
- [ ] Production bundle and PWA precache budgets fail on material regression.
- [ ] Mermaid loading/precache includes only required capabilities or has a documented budget exception.
- [ ] pnpm verify includes the new checks and passes.
