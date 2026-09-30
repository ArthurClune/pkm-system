---
# pkm-nny8
title: 'Hash-guarded delete: a stale delete over an unseen edit preserves the text under the daily-note conflict header'
status: completed
type: feature
priority: normal
created_at: 2026-09-29T13:20:56Z
updated_at: 2026-09-30T12:51:18Z
parent: pkm-a4t2
---

Decision (Arthur, 2026-09-29), from the review's policy question. The
offline-editing spec (`docs/superpowers/specs/2026-07-12-offline-editing-design.md`)
makes structural ops plain last-writer-wins, so a `delete` arriving after an
edit it never saw removes that edit with no conflict copy. The reverse order
is safe (the edit becomes an orphan edit on the daily note), so the outcome
depends on arrival order. `delete` is the only structural op that destroys
text. Realistic trigger: a device deletes a block while offline and another
device edited it meanwhile.

Sketch approved in conversation: the `delete` op gains an optional base hash
of the subtree it deletes, stamped where `update_text`'s hash is stamped
(`stampBaseTextHashes` on the main thread; the worker fills it when absent).
The server planner compares it with the current subtree. On a match the
delete applies as now. On divergence the delete still wins (who wins is
unchanged) and the server's current texts for that subtree land as children
under the block's daily-note conflict header (pkm-3g4n's machinery). Replicas
need nothing new: the client's own delete applies locally as today and the
conflict entry arrives over the feed. The CLI and MCP guarded delete pass the
fetched hash as the guarded update does. Cost: a subtree delete that raced an
edit puts the whole subtree's texts in the daily note, since one hash cannot
say which descendant changed.

Draft: needs its own brainstorm and spec, after F1 to F4 land. Until it
ships, the docs state the stale-delete limit as open, not accepted.



Spec: docs/superpowers/specs/2026-09-30-hash-guarded-delete-design.md (brainstormed 2026-09-30). The CLI line above is superseded: there is no standalone guarded delete; `pkm batch` `delete` is guarded from a fetched subtree.


Plan: docs/superpowers/plans/2026-09-30-hash-guarded-delete.md (Tasks 2-7; Task 1 is pkm-r5ra).

## Checklist

- [x] Field and hash: `DeleteOp.base_subtree_hash` (`Sha256Hex`), canonical `subtree_hash` / `subtreeHash`, pinned by `shared/fixtures/subtree_hash.json`; replay hash ignores it
- [x] Server landing: a diverged guarded delete still wins, after the server's texts land nested (fresh uids, text only) under `[[conflict]] [[Page]] — deleted while edited elsewhere`, or today's existing header for the block
- [x] Web stamping: `stampBaseTextHashes` on the main thread and `enqueueBatch` in the worker
- [x] CLI/MCP stamping: `pkm batch` and the MCP `batch` tool fetch each deleted uid and stamp from that subtree, advanced through the batch's earlier ops
- [x] E2E: `web/e2e/conflict-landing.spec.ts` drives a raced delete through the editor, queue, ops route and feed
- [x] Docs: sync-and-offline, backend, cli-and-mcp, frontend module map, sync-recovery, docs/cli.md

## Summary of Changes

`delete` carries an optional `base_subtree_hash`: the sha256 of one
`{uid} {text_hash(text)}` line per block in the deleted subtree, sorted by uid.
Both op hash fields are typed `Sha256Hex` and minted only by
`text_hash`/`subtree_hash` (Python) and `sha256Hex`/`subtreeHash` (web). The
web stamps it wherever it stamps `update_text`'s hash; `pkm batch` and the MCP
batch tool stamp it from a `GET /api/block/{uid}` taken at command time. On a
mismatch the server still applies the delete, but first copies the subtree's
current texts, nested, onto today's daily page under a
`— deleted while edited elsewhere` conflict header. A hashless or matching
delete behaves as before. The e2e test and architecture docs landed with the
last task; the docs no longer describe the stale-delete gap as open.


Final review fix: copies never land under a conflict header inside the subtree being deleted (`_conflict_landing` takes `exclude`; a fresh header is used instead), so a header the user had dragged under the block cannot cascade the copies away. Verified: server 2217 passed, pyrefly/ruff clean, web pnpm verify green (2920 unit, 72/72 Playwright), perf/check.sh backend and frontend no changes. Follow-ups: pkm-67j1 (clone-once stamping), pkm-amw9 (per-page subtree fetch in pkm batch).
