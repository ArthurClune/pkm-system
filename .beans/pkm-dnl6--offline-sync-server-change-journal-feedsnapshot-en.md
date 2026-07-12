---
# pkm-dnl6
title: 'Offline sync: server change journal + feed/snapshot endpoints'
status: in-progress
type: task
priority: normal
created_at: 2026-07-12T17:38:13Z
updated_at: 2026-07-12T18:15:18Z
parent: pkm-y8p0
---

Spec build-order steps 1-2 (server protocol), implemented via docs/superpowers/plans/2026-07-12-offline-sync-server.md: trigger-maintained changes journal (schema split BASE_DDL/SERVER_DDL, recursive_triggers), windowed /api/sync/changes with dependency pages + reset flag, /api/sync/snapshot, post-commit WS seq nudge from every journaled write path, batch_id idempotency (applied_batches, request-hash bound, indefinite retention), create_page op, base_text_hash conflict handling with conflict-copy blocks, OpenAPI/type regen.

## Execution checklist (plan tasks)

- [x] Task 1: journal schema split + triggers + recursive_triggers pragma
- [x] Task 2: window dedupe core
- [x] Task 3: /api/sync/changes + /api/sync/snapshot
- [x] Task 4: WS seq nudge on journaled commits
- [ ] Task 5: idempotent op batches (batch_id)
- [ ] Task 6: create_page op
- [ ] Task 7: base_text_hash conflict handling
- [ ] Task 8: regenerate API artifacts + full verification
