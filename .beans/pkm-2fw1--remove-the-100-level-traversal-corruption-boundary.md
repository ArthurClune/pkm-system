---
# pkm-2fw1
title: Remove the 100-level traversal corruption boundary in ops_apply
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:54:33Z
updated_at: 2026-07-31T15:54:33Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 1.

**References:** server/src/pkm/server/ops_apply.py:20-58,70-80

Both ancestry cycle detection and subtree enumeration silently stop at depth 100. A legal deeper hierarchy can be moved under one of its descendants because the root is no longer seen, creating a cycle. A cross-page move updates only the first 101 levels, leaving deeper descendants on the source page with parents on the destination page.

**Direction:** Traverse the complete hierarchy with cycle-safe recursive SQL, or enforce a documented depth limit before mutation. Cross-page moves must update every descendant or fail atomically.

- [ ] Add depth-boundary tests at 100, 101, and deeper
- [ ] Verify cycle prevention and every descendant's page after a cross-page move
- [ ] Replace the silent traversal cap with complete traversal or explicit validation
