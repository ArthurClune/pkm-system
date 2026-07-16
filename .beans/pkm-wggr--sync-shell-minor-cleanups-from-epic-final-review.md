---
# pkm-wggr
title: Sync shell minor cleanups from epic final review
status: todo
type: task
created_at: 2026-07-16T12:08:59Z
updated_at: 2026-07-16T12:08:59Z
---

Three Minor findings from the pkm-c1cg final whole-branch review (all in sync shells, none merge-blocking):

- [ ] SyncProvider.tsx:152-160: applySync computes transitions from problemRef.current which is refreshed only at render; two same-tick dispatches share a stale prev. Update problemRef.current inside applySync after setProblem.
- [ ] opQueue.ts:356-377: replica queue kick landing between the drain's final drainAgain check and .finally clearing drainRun is dropped (legacy queue has missedKick; replica does not). Add a drainAgain re-check in finally or document the window.
- [ ] opQueue.ts:576: unreachable continue after the poison path. Delete or comment as deliberate defense.
