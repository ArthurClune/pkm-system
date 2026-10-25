---
# pkm-vene
title: Over-limit stale-edit landing can re-create a deleted or renamed-away page
status: in-progress
type: bug
priority: low
created_at: 2026-10-25T12:48:37Z
updated_at: 2026-10-25T12:48:37Z
parent: pkm-mfd0
---

Found while planning the server clean-ups (2026-10-25, R1). When a stale offline edit is too long to replay, the server lands the client's text as a daily-note conflict entry exactly as sent; its old links can re-create a page that was deleted or renamed away meanwhile. Reproduced on a scratch server. Fix in security/batch-server Task 8 (steps 4–8).

- [ ] Red test from the repro
- [ ] Landing never re-creates a deleted/renamed-away page (unlink or rewrite stale titles in the landed note, as the replay would)
- [ ] troubleshooting.md row
