---
# pkm-r747
title: Linked references include the page's own blocks
status: completed
type: bug
priority: normal
created_at: 2026-09-22T20:06:45Z
updated_at: 2026-09-22T20:10:10Z
---

Blocks on page P that reference [[P]] (e.g. Roam-style {{[[TODO]]}} markers on the TODO page) appear in P's Linked references. Unlinked references already exclude the current page (b.page_id != ?); linked references should match. Fix _backlinks in routes_pages.py and the offline shim.

- [x] failing server test
- [x] fix _backlinks (count, page list, rows)
- [x] offline shim parity
- [x] verify

## Summary of Changes

Root cause: `_backlinks` (routes_pages.py) and the shim's `backlinks()` (localApi/pages.ts) never excluded the target page's own blocks, while unlinked references already did. Roam-style `{{[[TODO]]}}` markers contain a literal `[[TODO]]`, so every such block on the TODO page was a ref to TODO and showed as a linked reference to itself. Prod had 345 self-referencing blocks graph-wide.

Fix: `AND b.page_id != ?` on the count and page-list queries in both engines (the rows query is already bounded by the page list). Parity seed gains a self-ref block (uid_b11) so the fixture pins it on both engines. Symptom row added to backend.md.
