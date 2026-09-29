---
# pkm-fe9b
title: Other concurrent-edit 400s still wedge the queue (cross-page parent, stale move page_title, cycle)
status: todo
type: bug
priority: normal
created_at: 2026-09-28T22:40:50Z
updated_at: 2026-09-29T09:55:12Z
---

Found in the pkm-foap review (M10). pkm-foap stopped ops on missing blocks/parents from wedging the queue, but other 400s from concurrent edits on two devices still poison a batch and block delivery: a create under a parent another device moved to a different page ("parent is on a different page"), a cross-page move whose page_title is stale ("page_title does not match parent's page"), and a cycle made by two concurrent moves ("move would create a cycle"). Decide per case (Arthur) whether to land a daily-note note and apply the rest of the batch, as pkm-foap did.

## Arthur's rulings (2026-09-29)

| Case | Server error today | Ruling |
|---|---|---|
| create under a parent now on another page (stale page_title) | `parent is on a different page` | Follow the parent: create on the parent's current page and ignore the op's page_title |
| cross-page move whose page_title no longer matches the parent's page | `page_title does not match parent's page` | Follow the parent: move onto the parent's current page |
| move that would create a cycle (concurrent moves) | `move would create a cycle` | Skip + note: the block stays put; a `move skipped: would create a cycle` child lands under the block's daily-note header; the rest of the batch applies; journal the moved subtree so replicas undo the optimistic move |

The replica's local apply must mirror these, following pkm-7788's pattern: skip a cycle move locally, and follow the parent for create.
