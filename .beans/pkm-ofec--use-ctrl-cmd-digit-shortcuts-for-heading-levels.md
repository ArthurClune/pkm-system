---
# pkm-ofec
title: Preserve heading typography while focused
status: in-progress
type: bug
priority: normal
created_at: 2026-07-16T21:05:39Z
updated_at: 2026-07-16T21:16:28Z
---

The existing Ctrl-Alt-0/1/2/3 shortcuts dispatch heading changes, but a focused block always renders as an unformatted textarea, making the shortcuts appear broken. Preserve exact heading size and weight while focused; Ctrl-Alt-0 restores plain-text typography.

## Checklist

- [x] Load beans workflow and search for related work
- [x] Explore current shortcut implementation, tests, and prior design
- [x] Confirm shortcut semantics and approve design
- [x] Write and commit design spec
- [ ] Review and approve written spec
- [ ] Write implementation plan
- [ ] Add failing tests first
- [ ] Implement shortcut behavior
- [ ] Run required verification
- [ ] Update bean summary and complete
- [ ] Commit and push changes
