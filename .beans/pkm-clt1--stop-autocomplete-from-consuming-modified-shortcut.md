---
# pkm-clt1
title: Stop autocomplete from consuming modified shortcuts
status: todo
type: bug
created_at: 2026-08-01T13:21:07Z
updated_at: 2026-08-01T13:21:07Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 10.

**References:** web/src/outline/keyboardPolicy.ts:110-121; web/src/components/Composer.tsx:48-54

The editor policy says autocomplete owns unmodified arrows/Enter/Tab/Escape, but Cmd/Ctrl/Shift variants are not rejected. Modified keys can navigate or pick autocomplete instead of performing native selection/navigation or editor commands. Composer duplicates the same modifier-insensitive behavior.

**Direction:** Explicitly validate the allowed modifier set and reuse one keyboard policy in both editors.

- [ ] Add modifier-combination tests
- [ ] Enforce unmodified autocomplete commands through a shared policy
