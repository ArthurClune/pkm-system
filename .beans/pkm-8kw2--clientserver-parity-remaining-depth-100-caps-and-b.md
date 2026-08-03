---
# pkm-8kw2
title: 'Client/server parity: remaining depth-100 caps and blank-ref handling'
status: completed
type: task
priority: normal
created_at: 2026-07-31T16:50:33Z
updated_at: 2026-08-03T13:44:12Z
parent: pkm-ulae
---

Follow-up from pkm-ulae ops-branch final review (pkm-2fw1/pkm-1rb5).

Server-side traversal is now complete and cycle-safe (pkm-2fw1) and blank titles are handled at the store boundary (pkm-1rb5), but three parity holes remain:

- routes_pages.py:82 read-path ancestors CTE still caps at depth<100 (display-only breadcrumbs; guarded by test_hardening.py cycle test)
- web/src/replica/localOps.ts:69-76 subtreeUids still has s.depth < 100 and relies on that cap as its only cycle stop, so offline deep moves/deletes diverge from server semantics despite the file's "mirrors ops_apply" claim
- TS extractRefs blank-ref parity: server-side ref indexing now skips blank [[   ]] refs; the web replica's reindex would still locally mint a "   " page — grammar/fixture alignment is cross-stack work

- [x] Align localOps.ts subtree traversal with the server's cycle-safe complete traversal
- [x] Decide read-path ancestors cap (removed; traversal is complete and cycle-safe)
- [x] Align Python/TS extractors and local indexing for blank references

Additional item from ops-branch re-review (pre-existing): _broadcast_op relays a control-whitespace page_title verbatim while the server stores the normalized form ("Foo\nBar" stored as "Foo Bar" but broadcast raw) — same replica-divergence shape as the blank-title case fixed in pkm-1rb5. Broadcasting the resolved/normalized title would cover both.

- [x] Broadcast the normalized page_title (or otherwise reconcile replica title keying with server normalization)

## Summary of Changes

- Broadcast ops now use the authoritative stored page title from the applied page row for create, create_page, and move operations, covering blank fallback, control-whitespace normalization, activation-time padding canonicalization, and cross-page moves while preserving same-page null broadcasts. An unreachable authoritative-row lookup now fails closed instead of retaining caller spelling.
- Blank references are now dropped in both pure extractors before local/server ref indexing, preserving byte-exact nonblank padding, regenerating the shared parity fixture, and covering the local replica so `[[   ]]` is ignored while valid refs in the same block still index.

## Task 10 status review

All parity items from this bean are now complete, and the task is ready to close.
