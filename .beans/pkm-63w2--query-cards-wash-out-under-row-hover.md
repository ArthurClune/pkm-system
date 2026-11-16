---
# pkm-63w2
title: Query cards wash out under row hover
status: completed
type: bug
priority: normal
created_at: 2026-11-16T09:09:33Z
updated_at: 2026-11-16T09:11:45Z
---

On a hovered (or, on iPad, tapped) query block in Cards view, each .query-card fills with --color-bg-subtle, nearly the row-hover grey, so the cards blur together. Table cells were fixed by sitting opaque on --color-bg-surface; cards need the same.

- [x] .query-card sits on --color-bg-surface
- [x] style test pins it
- [x] styling.md rule covers cards
- [x] lint/typecheck/unit + screenshot

## Summary of Changes

Symptom: in Cards view, a hovered (or on iPad, tapped) query block showed grey cards on a grey row, so the cards blurred together. Cause: `.query-card` filled with `--color-bg-subtle`, nearly the `--color-row-hover` grey. Fix: `.query-card` sits opaque on `--color-bg-surface`, like table body cells, so the cards read white with a border at rest and under hover. Rule in docs/architecture/styling.md § Controls (Tables).
