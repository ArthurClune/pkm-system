---
# pkm-8ui6
title: Legacy over-long titles skip the client check on drag, Unlinked Link and no-replica enqueue
status: todo
type: bug
priority: low
created_at: 2026-10-26T16:13:08Z
updated_at: 2026-10-26T16:13:08Z
parent: pkm-mfd0
---

From the security/batch-server final review (T12 Minor 4). Titles stored before the 1,000-character cap skip the client-side length check on drag-and-drop, the Unlinked references Link action and the no-replica enqueue path; the server still refuses. Prod has none (longest 260).

- [ ] Reproduce with a seeded legacy title
- [ ] Route those paths through the same admit check
