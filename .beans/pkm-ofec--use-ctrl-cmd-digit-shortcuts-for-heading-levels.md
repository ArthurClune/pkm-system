---
# pkm-ofec
title: Preserve heading typography while focused
status: completed
type: bug
priority: normal
created_at: 2026-07-16T21:05:39Z
updated_at: 2026-07-16T21:28:27Z
---

The existing Ctrl-Alt-0/1/2/3 shortcuts dispatch heading changes, but a focused block always renders as an unformatted textarea, making the shortcuts appear broken. Preserve exact heading size and weight while focused; Ctrl-Alt-0 restores plain-text typography.

## Checklist

- [x] Load beans workflow and search for related work
- [x] Explore current shortcut implementation, tests, and prior design
- [x] Confirm shortcut semantics and approve design
- [x] Write and commit design spec
- [x] Review and approve written spec
- [x] Write implementation plan
- [x] Add failing tests first
- [x] Implement shortcut behavior
- [x] Run required verification
- [x] Update bean summary and complete
- [x] Commit and push changes


## Summary of Changes

Focused heading textareas now receive heading-1/2/3 classes while focused, and the CSS shares the exact heading size/weight rules with the rendered headings. Ctrl-Alt-0 clears the class and restores plain typography; the shortcut pipeline itself was already working.
