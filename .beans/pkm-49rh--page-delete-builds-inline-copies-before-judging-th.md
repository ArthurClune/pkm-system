---
# pkm-49rh
title: Page delete builds inline copies before judging the text limit
status: completed
type: bug
priority: low
created_at: 2026-10-25T02:14:31Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf whole-branch review (2026-10-25). Page delete (and GET /api/delete-preview, read-only) builds the inline copies (_build_copies, inline_block_refs) before the new 'limit' blocker is judged, so a block of ~76k ((ref)) tokens to a 1M-char block allocates ~7.6e10 characters first. Bound the projected size (span count x source length) before splicing, and refuse with the existing limit blocker.

- [x] Red test: projected-size refusal without materialising
- [x] Same bound on delete-preview
- [x] troubleshooting.md row

## Summary of Changes

- Behaviour: page delete and GET /api/delete-preview project each referring block's inlined length (span count x source length) before splicing and refuse with the existing `limit` blocker, never materialising the copy; the `limit` blocker now outranks `attribute`/`residual` (table reads as precedence; props model updated). Red: a 10 x 200,000 case built 20M characters before refusing.
- Fix rounds beyond the first: copies are built only for blocks something references (e3f0d014; 200 blocks/125k chars was 176 s under the lock); per-source stop counts the copy's pre-blank projected length (6d52c741); a per-delete budget MAX_DELETE_COPY_CHARS on the summed projected length (b59f8b21), memoised projection (9efe1b45; 3,000 referrers 6.5 s -> 0.23 s); nesting judged on the spliced text before unlinking, delete, preview and replay (1d8dbfb9), with the unlink pass made linear in links removed (c84ab261; `[[T]]` x 40,000 23-38 s -> 1.3 s).
- Main commits: a89e77ff, e3f0d014, 6d52c741, b4b29b69 (stored-ack lookup off the loop), b59f8b21, 9efe1b45, 1d8dbfb9, c84ab261.
- Rulings: orchestrator, no total cap on a delete storing N blocks each within limits (each obeys the limits; N ops could write the same bytes directly); count the pre-blank projected copy length (prod max 34,863 chars, refuses nothing prod can delete); per-delete budget set far above prod's maximum, using the existing limit blocker; O1 (cross-block `[[` nesting via copies, ~cubic under the lock) is in scope here as round 5, docs deferred to Task 11's sweep. Residual known: a 1M-char block of 32-deep `[[T]]` still ~10 s to unlink (linear, pre-existing), dense tag/link copies ~3.5 s worst case at the budget. Unlink work past linear: pkm-6jyz.
- Follow-ups: pkm-6jyz (O2/O3), pkm-hlom.
