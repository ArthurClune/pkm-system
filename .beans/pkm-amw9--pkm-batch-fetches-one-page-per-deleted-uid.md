---
# pkm-amw9
title: pkm batch fetches one page per deleted uid
status: in-progress
type: task
priority: low
created_at: 2026-09-30T12:47:07Z
updated_at: 2026-09-30T13:34:33Z
parent: pkm-a4t2
---

`pkm batch` / MCP `apply_batch` (`server/src/pkm/client/workflows.py`) fetches `GET /api/block/{uid}` once per `delete` uid, sequentially, to stamp `base_subtree_hash`. That route reads the whole page's blocks to build one subtree (`routes_pages.py`), so an agent deleting 200 blocks from a 5k-block page pays 200 page reads before it posts.

Fix: group delete uids by page and take each subtree from one page fetch, reusing the page already fetched for `referenced_pages` when there is one. The uid -> page mapping needs one lookup per uid (or a batched lookup route), so weigh that against the saving.

- [x] Fetch count scales with pages, not deletes
- [x] Workflow test pins the fetch count (and no fetch for a batch with no deletes or only alias deletes)
