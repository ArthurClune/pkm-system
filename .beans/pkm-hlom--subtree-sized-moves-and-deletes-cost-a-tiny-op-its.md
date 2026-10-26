---
# pkm-hlom
title: Subtree-sized moves and deletes cost a tiny op its subtree under the write lock
status: todo
type: bug
priority: normal
created_at: 2026-10-26T18:59:59Z
updated_at: 2026-10-26T18:59:59Z
parent: pkm-mfd0
---

From the security/batch-server fix-wave re-review (I-A). A tiny cross-page move of a root block with 20,000 children costs about 0.19 s under the write lock, so one ~47 KB batch of 500 such moves holds it about 90 s, repeatable each batch. Pre-existing; not charged to any batch budget. backend.md § The write lock states apply_batch is linear in the request and the touched blocks' rows/subtrees.

- [ ] Measure delete as well as move
- [ ] Charge subtree size to a per-batch budget (land/refuse past it) or make the move O(1) in children
- [ ] troubleshooting row
