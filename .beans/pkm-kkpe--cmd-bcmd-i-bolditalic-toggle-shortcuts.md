---
# pkm-kkpe
title: Cmd-B/Cmd-I bold+italic toggle shortcuts
status: completed
type: feature
priority: normal
created_at: 2026-07-20T19:32:51Z
updated_at: 2026-07-20T20:07:01Z
---

Add Cmd-B (bold, **) and Cmd-I (italic, __) editor shortcuts with toggle semantics; generalize the Cmd-K policy branch into a meta-wrap table; codify modifier conventions in keyboardPolicy.ts.

## Design decisions (user-approved)
- Toggle: pressing again unwraps (both selection shapes); caret between empty pair deletes it
- Meta-only modifier (consistent with Cmd-K, preserves emacs Ctrl-B/I)
- After wrapping, inner text stays selected (stacking + un-toggle work)
- Shared branch requires !shiftKey — Cmd-Shift-K stops link-wrapping (deliberate)
- Out of scope: caret-inside-word toggle expansion

## Todo
- [x] Spec written and committed (docs/superpowers/specs/2026-07-20-bold-italic-shortcuts-design.md)
- [x] Implementation plan
- [x] toggleEmphasis in keyEdits.ts (TDD)
- [x] META_WRAP_EDITS table in keyboardPolicy.ts + convention comment
- [x] Unit + policy tests, e2e for Cmd-B
- [x] verify: pnpm verify, server untouched

## Summary of Changes

- `toggleEmphasis` pure transform in web/src/outline/keyEdits.ts: Cmd-B/Cmd-I toggle **bold**/__italic__ around the selection (unwrap for both selection shapes), insert/delete an empty centered pair at a bare caret. Multi-line-selection non-rendering documented as deliberate.
- META_WRAP_EDITS table in web/src/outline/keyboardPolicy.ts replaces the one-off Cmd-K branch; future wraps (~~, ^^) are one-line entries. Modifier convention codified in a comment: letter-chord editing shortcuts are Meta-only (emacs Ctrl bindings preserved); Cmd-Shift-K deliberately no longer wraps links.
- Shell untouched: shortcuts ride the existing key-edit/draft path.
- Tests: 9 keyEdits unit tests, 6 policy tests, Playwright e2e wrap->unwrap->rewrap->render round-trip (afterPaint waits for the pre-existing rAF selection-restore race, same idiom as bracket auto-pair). Full pnpm verify green (1271 unit, 17 e2e).
- Audit outcome: in-editor shortcut architecture confirmed sound; global listeners deliberately left colocated. Spec: docs/superpowers/specs/2026-07-20-bold-italic-shortcuts-design.md, plan: docs/superpowers/plans/2026-07-20-bold-italic-shortcuts.md.
