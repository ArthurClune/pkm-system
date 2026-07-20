---
# pkm-kkpe
title: Cmd-B/Cmd-I bold+italic toggle shortcuts
status: in-progress
type: feature
priority: normal
created_at: 2026-07-20T19:32:51Z
updated_at: 2026-07-20T19:39:25Z
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
- [ ] Implementation plan
- [x] toggleEmphasis in keyEdits.ts (TDD)
- [x] META_WRAP_EDITS table in keyboardPolicy.ts + convention comment
- [ ] Unit + policy tests, e2e for Cmd-B
- [ ] verify: pnpm verify, server untouched
