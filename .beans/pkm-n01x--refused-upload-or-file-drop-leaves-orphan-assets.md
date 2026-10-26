---
# pkm-n01x
title: Refused upload or file drop leaves orphan assets
status: completed
type: bug
priority: low
created_at: 2026-10-24T14:58:27Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

When useOutline.run() refuses a command for the outline depth cap, an upload or file drop has already uploaded its files: they become orphan assets, and a scroll target is set for a uid that never renders. Only reachable at outline level ~100.

- [x] Red test: a file drop at the depth cap uploads nothing or releases what it uploaded
- [x] Judge depth before uploading, or release the fresh assets on refusal (the undo path's releaser already does this)
- [x] Clear the scroll-to target on refusal

## Summary of Changes

- Behaviour: `useOutline.run()` returns whether the command applied and releases the command's fresh uploads on refusal (`releaseUnusedAssets`, the undo path's releaser); `onFiles` resolves to run's result; the scroll target is set only when the command applied. Task 10 routes the web's batch-size refusal through the same path, so fresh uploads are released then too.
- Commits: 30fdf394, 42f855e9. Troubleshooting Editor row.
- Notes: the brief's /upload test at level 100 was unreachable (upload plans a sibling, level 100); tests use a legacy tree with a level-101 block and a text-limit refusal for the scroll case. No ruling needed. Follow-ups: none.
