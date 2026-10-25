---
# pkm-n01x
title: Refused upload or file drop leaves orphan assets
status: in-progress
type: bug
priority: low
created_at: 2026-10-24T14:58:27Z
updated_at: 2026-10-25T09:52:34Z
parent: pkm-mfd0
---

When useOutline.run() refuses a command for the outline depth cap, an upload or file drop has already uploaded its files: they become orphan assets, and a scroll target is set for a uid that never renders. Only reachable at outline level ~100.

- [ ] Red test: a file drop at the depth cap uploads nothing or releases what it uploaded
- [ ] Judge depth before uploading, or release the fresh assets on refusal (the undo path's releaser already does this)
- [ ] Clear the scroll-to target on refusal
