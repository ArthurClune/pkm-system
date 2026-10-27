---
# pkm-8ui6
title: Legacy over-long titles skip the client check on drag, Unlinked Link and no-replica enqueue
status: scrapped
type: bug
priority: low
created_at: 2026-10-26T16:13:08Z
updated_at: 2026-10-27T10:29:47Z
parent: pkm-mfd0
---

From the security/batch-server final review (T12 Minor 4). Titles stored before the 1,000-character cap skip the client-side length check on drag-and-drop, the Unlinked references Link action and the no-replica enqueue path; the server still refuses. Prod has none (longest 260).

- [ ] Reproduce with a seeded legacy title
- [ ] Route those paths through the same admit check


## Reasons for Scrapping

Arthur's ruling, 2026-10-27: prod holds no title past the 1,000-character cap (longest 260, checked on the 2026-10-27 backup) and the server refuses an over-long title on every path, so the client-side gap can only cost a refusal notice on data that does not exist.
