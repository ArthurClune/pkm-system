---
# pkm-wj3x
title: Chained stale edits after a rename/delete replay land spurious conflict entries
status: completed
type: bug
priority: low
created_at: 2026-10-14T10:51:43Z
updated_at: 2026-10-14T12:42:43Z
---

Found in the pkm-ynze final review. A rename or page-delete replay (block_rewrites retitle/unlink rows) rebases the FIRST stale hashed edit of a block onto the rewritten text, but the replica stamps the next edit's base_text_hash from its own previous text (still holding the old title). The server records no rewrite for the replayed write, so edit N+1's base matches nothing and lands a spurious "overwritten" conflict entry in today's daily note. No text is lost; it is noise on every later debounce batch of the chain.

pkm-ynze fixed the same shape for stale-batch unlinks by recording unlink rows for the written text. The same mechanism (a block_rewrites row from the client's op-text hash to the written-text hash whenever a replay changed what was written) would cover renames and delete replays.

## Todo

- [x] Reproduce: rename X->Y, offline device sends two chained hashed edits containing [[X]]
- [x] Record a rewrite row for replay-changed writes
- [x] Test the chain applies clean
