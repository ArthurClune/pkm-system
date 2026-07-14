---
# pkm-owo8
title: Ignore pi superpowers checkout
status: completed
type: task
priority: normal
created_at: 2026-07-14T15:20:19Z
updated_at: 2026-07-14T15:21:45Z
---

Update git ignore rules so the local pi superpowers checkout under .pi/git/ is not tracked, then tidy repository status.

- [x] Inspect current git status and ignore rules
- [x] Add ignore rule for .pi/git/*
- [x] Remove any tracked .pi/git contents from the index if present
- [x] Verify repository status

## Summary of Changes

- Added a root ignore rule for `.pi/git/` so the pi-managed superpowers checkout stays local.
- Removed `.pi/git/.gitignore` from the git index.
- Verified no `.pi/git` paths are tracked and representative paths are ignored.
