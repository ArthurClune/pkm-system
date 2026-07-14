---
# pkm-e1pw
title: Edits flash then revert after enter-block deploy
status: in-progress
type: bug
priority: critical
created_at: 2026-07-14T20:51:47Z
updated_at: 2026-07-14T20:55:27Z
---

After deploying the Enter/split fix, edits such as changing a line to Heading 1 flash optimistically then revert. Need root-cause whether ops are not sent, rejected, or overwritten by stale refetch; compare deployed cde74d6 against current main.

## Debug checklist
- [ ] Reproduce on deployed/current build
- [ ] Trace whether /api/ops is sent and accepted
- [ ] Identify root cause/recent change
- [ ] Add failing regression test
- [ ] Implement fix or deploy already-fixed main
- [x] Verify (deploy in progress)
