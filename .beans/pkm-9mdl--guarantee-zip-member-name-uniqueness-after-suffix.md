---
# pkm-9mdl
title: Guarantee ZIP member-name uniqueness after suffix generation
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 18).

## Context

**References:** `server/src/pkm/assets_core.py:64-76`

zip_arcnames() checks whether the original filename is used but does not recheck the generated name (<sha8>).ext. Generated-looking input names or shared eight-character SHA prefixes can still produce duplicate ZIP members.

**Direction:** Loop until the candidate is unused, using a longer SHA or incrementing suffix when necessary.

## Tasks

- [ ] Test generated-looking names, shared SHA prefixes, and case-insensitive collisions
- [ ] Assert every archive name is unique
