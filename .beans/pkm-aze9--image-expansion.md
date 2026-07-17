---
# pkm-aze9
title: image expansion
status: completed
type: feature
priority: normal
created_at: 2026-07-17T16:49:02Z
updated_at: 2026-07-17T17:51:20Z
---

Like PDFs, images should expand to fill the viewport when click on

## Design and implementation checklist

- [x] Explore project context, related image/PDF components, tests, and recent commits
- [x] Clarify interaction and accessibility requirements
- [x] Compare implementation approaches and agree on a design
- [x] Write, self-review, commit, and obtain approval for the design spec
- [x] Write and approve the implementation plan
- [x] Implement via TDD in an isolated worktree
- [x] Run required verification and review
- [x] Commit, push, merge with --no-ff, push, and complete the bean

## Implementation execution

- [x] Task 1: accessible uploaded-image modal behavior
- [x] Task 2: viewport styling and real-browser coverage
- [x] Task 3: full verification, review, and bean handoff

## Summary of Changes

Implemented uploaded `/assets/` image expansion with a portalled, viewport-contained modal. Added keyboard and pointer opening, Close/Escape/backdrop closing, modal focus containment and restoration, body scroll lock, editable-block click containment, preserved offline failure recovery, CSS coverage, and a real uploaded-image Playwright scenario. Updated PDF E2E selectors for the new accessible image-trigger name. Verified twice with `cd web && pnpm verify` after code review.

## Completion Notes

Merged with `--no-ff` into `main` at `df0f90616f877ed5b11d8e6ebf27b0c3c85c440e`, verified the merged tree with `cd web && pnpm verify` (1,208 unit tests and 11 Playwright tests passed), and pushed `main` to origin.
