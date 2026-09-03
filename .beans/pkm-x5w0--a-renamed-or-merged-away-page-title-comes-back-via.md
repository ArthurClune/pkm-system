---
# pkm-x5w0
title: A renamed or merged-away page title comes back via last-write-wins from a stale device
status: todo
type: bug
created_at: 2026-09-03T09:22:53Z
updated_at: 2026-09-03T09:22:53Z
---

Observed 2026-09-02 (pkm-n31j incident): SIS was merged into Student Record System at 22:05:25; at 22:05:33 a second iPad context posted an update_text carrying the old text 'Tags:: #[[SIS]]' for block m8Zi85WyV. Push-time resolution is LWW with the losing text preserved as a [[conflict]] sibling (block y6DXYcOyOpO1 on SITS), and the winning text's [[SIS]] re-created the page (4518), which the user then had to merge again. Working as specified, but any rename/merge while another device holds unsynced edits to a rewritten block will resurrect the old title. Options to weigh: (a) server-side, when an incoming stale update_text loses its base_text_hash check, re-run the rename rewrite map over the incoming text before applying (renames are already recorded per block by rewrite_snapshotted_blocks); (b) client-side, on receiving a page tombstone, rewrite queued pending ops' texts that reference the deleted title when the feed shows where it went (harder: the feed does not say 'merged into'); (c) accept and document (done in sync-and-offline.md symptom table). Decide before implementing; (a) is the smallest.
