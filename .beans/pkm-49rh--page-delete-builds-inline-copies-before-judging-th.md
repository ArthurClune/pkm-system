---
# pkm-49rh
title: Page delete builds inline copies before judging the text limit
status: in-progress
type: bug
priority: low
created_at: 2026-10-25T02:14:31Z
updated_at: 2026-10-25T09:52:34Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf whole-branch review (2026-10-25). Page delete (and GET /api/delete-preview, read-only) builds the inline copies (_build_copies, inline_block_refs) before the new 'limit' blocker is judged, so a block of ~76k ((ref)) tokens to a 1M-char block allocates ~7.6e10 characters first. Bound the projected size (span count x source length) before splicing, and refuse with the existing limit blocker.

- [ ] Red test: projected-size refusal without materialising
- [ ] Same bound on delete-preview
- [ ] troubleshooting.md row
