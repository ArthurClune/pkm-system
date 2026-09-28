---
# pkm-1b2w
title: Poison repair (rebase) cannot get past a damaged replica file
status: completed
type: bug
priority: normal
created_at: 2026-09-28T19:17:18Z
updated_at: 2026-09-28T19:19:55Z
---

Follow-up to pkm-h1c6, seen live 2026-09-28 20:13 after deploying it: a fully relaunched iPad PWA re-runs the rejected-batch repair on startup, which is rebaseAuthoritative('poison') -> commitRecovery kind 'rebase' -> applySnapshot into the same damaged file -> SQLITE_CORRUPT -> 'Local repair failed', forever. pkm-h1c6 only taught the reset path to replace the file. The poison path must not reset (it would drop the later valid durable rows), so a rebase that meets corruption must replace the file and carry every durable pending row (ids, batch ids, poisoned, error) across verbatim before applying the snapshot.

## Todo
- [x] Failing test: rebase over a damaged file keeps every durable row and applies the snapshot on a fresh file
- [x] Implement in workerHandlers commitRecovery (rebase)
- [x] Docs: sync-and-offline rebootstrap note + troubleshooting row
- [x] verify, perf, merge, deploy

## Summary of Changes

- `workerHandlers.ts`: `rebaseOrReplaceFile` — a rebase commit whose snapshot apply throws a corruption error replaces the file (shared `replaceFileAfter`, also used by `rebuildOrReplaceFile`), reinstalls the schema, re-inserts every durable pending row verbatim (id, batch_id, ops_json, poisoned, error) in its own committed transaction, then applies the snapshot (which reapplies pending).
- Tests: rows carried across with ids intact, snapshot + reapply on the new file, post-repair deleteBatch by id works; carried rows survive a snapshot failure on the new file.
- Docs: sync-and-offline § Rebootstrap triggers note; troubleshooting row.
- Verified: pnpm verify exit 0 (2659 unit, 62 e2e).
