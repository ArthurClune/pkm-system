---
# pkm-4sdp
title: Deploy from the local checkout, not GitHub
status: completed
type: task
priority: normal
created_at: 2026-10-07T10:42:50Z
updated_at: 2026-10-07T10:44:25Z
---

update.sh pulled the prod checkout from GitHub, so a deploy needed a push first (and stalled on the keychain credential prompt). Deploy from the local dev checkout's main instead.

## Checklist
- [x] update.sh: fetch main from a local source (PKM_SRC, default the app checkout's origin), refuse a non-local source, ff-only
- [x] install.sh: clone from the main local checkout, not its GitHub origin
- [x] Repoint the existing prod checkout's origin at the dev checkout
- [x] Docs: deploy/README.md, overview.md, AGENTS.md
- [x] Deploy with the new update.sh and verify

## Summary of Changes

- update.sh fetches main from PKM_SRC or the app checkout's origin, refuses a non-directory source, and fast-forwards with merge --ff-only FETCH_HEAD. Tested in a stubbed PKM_HOME: local origin deploys, GitHub URL refuses (exit 1), PKM_SRC overrides, diverged checkout stops before any build.
- install.sh clones the main local checkout (via --git-common-dir), so it works from a worktree too.
- Prod checkout's origin repointed to /Users/arthur/code/llm/pkm; deployed 78734fcc with the new script and verified (service loaded, 8974 owned by its child, served bundle current).
- Docs: deploy/README.md, overview.md, AGENTS.md.
