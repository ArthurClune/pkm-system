---
# pkm-dbr1
title: Replica keeps sibling shifts when the server applies a create/move to a different group
status: todo
type: bug
created_at: 2026-10-03T12:56:07Z
updated_at: 2026-10-03T12:56:07Z
parent: pkm-nws9
---

Same divergence class as pkm-hz8w, for ops the server APPLIES rather than skips: the client's optimistic apply shifts one sibling group, the server shifts another, and the client's shifted rows are never re-shipped, so the replica keeps +1 keys. Shapes (found by reading the code during pkm-hz8w; the sync property does not generate them yet): (1) a top-level move with no page_title of a live block that another device moved to another page, not yet pulled by this client — the server shifts the block's current page, the replica shifted the old one; (2) a top-level create or move whose page_title names a page another device renamed, not yet pulled — the server get_or_creates a new page under the old title, the replica shifted its old page. Ruling (Arthur 2026-10-03): fix later. First widen the sync property's generator (cross-page moves, page renames) so it finds these, then design the fix.

- [ ] Widen web/src/props/sync arbitraries: cross-page moves, page renames
- [ ] Reproduce both shapes with the property
- [ ] Design and fix
