---
# pkm-amw9
title: pkm batch fetches one page per deleted uid
status: completed
type: task
priority: low
created_at: 2026-09-30T12:47:07Z
updated_at: 2026-09-30T13:39:05Z
parent: pkm-a4t2
---

`pkm batch` / MCP `apply_batch` (`server/src/pkm/client/workflows.py`) fetches `GET /api/block/{uid}` once per `delete` uid, sequentially, to stamp `base_subtree_hash`. That route reads the whole page's blocks to build one subtree (`routes_pages.py`), so an agent deleting 200 blocks from a 5k-block page pays 200 page reads before it posts.

Fix: group delete uids by page and take each subtree from one page fetch, reusing the page already fetched for `referenced_pages` when there is one. The uid -> page mapping needs one lookup per uid (or a batched lookup route), so weigh that against the saving.

- [x] Fetch count scales with pages, not deletes
- [x] Workflow test pins the fetch count (and no fetch for a batch with no deletes or only alias deletes)

## Summary of Changes

apply_batch resolves delete subtrees through workflows._delete_subtrees: a uid on a page the batch already fetched for referenced_pages costs no request; otherwise one get_block names its page, which is fetched once with get_page_blocks and cached for every later delete on it. A 404 still maps to no hash; any other ApiError still fails the batch (a malformed uid still reaches get_block and its 422). A uid missing from the freshly fetched page (a race) falls back to the get_block payload. New pure planning.find_block. test_client_workflows.py pins fetch counts (none for no deletes or alias-only deletes, 1+1 for N deletes on one page, none extra for a referenced page, 404, non-404 propagation). test_batch_delete_stale_fetch_lands_the_copy now stales both reads. cli-and-mcp.md corrected (it said one GET /api/block per uid). No route change. perf/check.sh backend: no changes.
