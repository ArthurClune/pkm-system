---
# pkm-dnl6
title: 'Offline sync: server change journal + feed/snapshot endpoints'
status: completed
type: task
priority: normal
created_at: 2026-07-12T17:38:13Z
updated_at: 2026-07-12T18:46:09Z
parent: pkm-y8p0
---

Spec build-order steps 1-2 (server protocol), implemented via docs/superpowers/plans/2026-07-12-offline-sync-server.md: trigger-maintained changes journal (schema split BASE_DDL/SERVER_DDL, recursive_triggers), windowed /api/sync/changes with dependency pages + reset flag, /api/sync/snapshot, post-commit WS seq nudge from every journaled write path, batch_id idempotency (applied_batches, request-hash bound, indefinite retention), create_page op, base_text_hash conflict handling with conflict-copy blocks, OpenAPI/type regen.

## Execution checklist (plan tasks)

- [x] Task 1: journal schema split + triggers + recursive_triggers pragma
- [x] Task 2: window dedupe core
- [x] Task 3: /api/sync/changes + /api/sync/snapshot
- [x] Task 4: WS seq nudge on journaled commits
- [x] Task 5: idempotent op batches (batch_id)
- [x] Task 6: create_page op
- [x] Task 7: base_text_hash conflict handling
- [x] Task 8: regenerate API artifacts + full verification

## Summary of Changes

Implemented on branch worktree-pkm-dnl6-offline-sync-server (base 808a94c), 8 plan tasks, each TDD'd, task-reviewed, plus a whole-branch final review (verdict: ready to merge, no fix-now findings).

- schema.py split into BASE_DDL (client replica) + SERVER_DDL (changes journal via 9 row-level triggers, applied_batches); PRAGMA recursive_triggers=ON on both connections so cascade deletes journal tombstones.
- sync_core.py (Functional Core): dedupe_window — cursor advances over raw journal rows (A@1/B@2/A@100 safe).
- routes_sync.py: GET /api/sync/changes (windowed, dependency-complete hydration, reset flag) + /api/sync/snapshot, both in one explicit read transaction on a per-request connection.
- notify.py + wiring: post-commit WS {type:seq} nudge from every journaled write path (ops, sidebar, page create/delete, both daily auto-creates); web socket.ts ignores non-batch frames.
- routes_ops.py: batch_id idempotency (stored ack replay, 409 on hash mismatch, 400s not recorded, no pruning); ops_core.batch_request_hash.
- create_page op (get_or_create semantics, journaled, replay-safe).
- base_text_hash conflict ladder in ops_core/ops_apply: orphan→daily page, identical→noop, hashless→legacy, match→apply, stale→LWW + [[conflict]] sibling copy.
- OpenAPI/TS artifacts regenerated; web BlockOp union extended; tree.ts applyOne skips create_page.

Suites at HEAD: server pytest 349, pyrefly 0, ruff clean; web vitest 418, tsc clean.

Follow-ups filed: pkm-o9o5 (generation token, blocks pkm-gtov), pkm-x7a5 (small tests/cleanups); carry-forward notes appended to pkm-gtov.
