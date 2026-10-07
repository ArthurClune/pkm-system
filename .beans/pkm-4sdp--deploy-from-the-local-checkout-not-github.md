---
# pkm-4sdp
title: Deploy from the local checkout, not GitHub
status: in-progress
type: task
priority: normal
created_at: 2026-10-07T10:42:50Z
updated_at: 2026-10-07T10:43:47Z
---

update.sh pulled the prod checkout from GitHub, so a deploy needed a push first (and stalled on the keychain credential prompt). Deploy from the local dev checkout's main instead.

## Checklist
- [x] update.sh: fetch main from a local source (PKM_SRC, default the app checkout's origin), refuse a non-local source, ff-only
- [x] install.sh: clone from the main local checkout, not its GitHub origin
- [ ] Repoint the existing prod checkout's origin at the dev checkout
- [x] Docs: deploy/README.md, overview.md, AGENTS.md
- [ ] Deploy with the new update.sh and verify
