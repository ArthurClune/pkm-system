---
# pkm-e1pw
title: Edits flash then revert after enter-block deploy
status: completed
type: bug
priority: critical
created_at: 2026-07-14T20:51:47Z
updated_at: 2026-07-14T20:56:17Z
---

After deploying the Enter/split fix, edits such as changing a line to Heading 1 flash optimistically then revert. Need root-cause whether ops are not sent, rejected, or overwritten by stale refetch; compare deployed cde74d6 against current main.

## Debug checklist
- [x] Reproduce on deployed/current build
- [x] Trace whether /api/ops is sent and accepted
- [x] Identify root cause/recent change: stale initial payloads were still adopted after sync.idle() resolved while replica-backed ops remained in Sync.pending
- [x] Add failing regression test
- [x] Implement fix
- [x] Verify and deploy

## Summary of Changes

- Added a regression test for stale same-page initial rerenders while the replica-backed sync queue still has pending ops.
- Updated useOutline to ignore stale initial payloads while either localWritesRef is active or Sync.pending is non-zero.
- Verified with cd web && pnpm verify and deployed production to 8774abe.
