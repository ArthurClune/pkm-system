---
# pkm-1mx9
title: Report replica diagnostics to the server when corruption triggers a rebuild
status: completed
type: task
priority: normal
created_at: 2026-09-03T09:16:13Z
updated_at: 2026-09-03T09:22:39Z
---

## Why

pkm-n31j made a corrupt replica (FTS5 `SQLITE_CORRUPT_VTAB`) self-heal with one automatic schema rebuild, but the on-device cause of the FTS index / content divergence is still unknown, and after the fix the next occurrence would be silent. Before the rebuild drops the evidence, the client should gather what the database says about itself and send it to the server log, where the access log already records the surrounding requests.

## Shape

- Worker RPC `diagnostics()` (workerHandlers.ts): `PRAGMA quick_check`, FTS5 `integrity-check` on `blocks_fts` and `pages_fts` (each result or error text), row counts (`blocks`, `pages`, `blocks_fts_docsize`, `pages_fts_docsize`, `pending_ops`), `sync_client_meta` (cursor, generation, schema_version), `sqlite_version()`. Never throws: every probe is try/caught into the report.
- `replicaSync.ts`: on a fresh corruption, gather the report BEFORE `recover("reset")` (the reset drops the tables), then fire-and-forget `POST /api/client/diagnostics` with `{kind: "replica-corruption", error, report, client: {userAgent, standalone, visibility}}`. Failures to report are swallowed; the rebuild does not wait on the POST.
- Server `POST /api/client/diagnostics` (routes_sync.py): authenticated, logs one WARNING line on the `pkm.sync` logger with the JSON body, returns `{ok: true}`. Not journal-advancing: no nudge.
- Contracts: openapi.json + gen-types regenerated; `backend.md` API table row; `sync-and-offline.md` one sentence in the corruption trigger row.

## Plan

- [x] Failing test: worker `diagnostics()` returns counts/meta and survives a broken FTS index
- [x] Failing test: a fresh corruption posts the report before the reset and never blocks on it
- [x] Failing test: server route logs the body and answers ok
- [x] Implement worker handler, facade method, replicaSync hook, server route
- [x] Regenerate openapi.json + types; update backend.md API table and sync doc
- [x] pnpm verify + server pytest/pyrefly/ruff -- web: 2531 unit at 98.2% lines, 56 e2e; server: 1616 tests at 97.3%, ruff + pyrefly clean

## Summary of Changes

- web/src/replica/client.ts: ReplicaDiagnostics type and diagnostics() on the Replica facade.
- web/src/replica/workerHandlers.ts: collectDiagnostics -- sqlite_version, PRAGMA quick_check(5), FTS5 'integrity-check', 1 on blocks_fts and pages_fts (the 1 makes FTS5 compare against the external content table; without it an index missing a content row passes), row counts incl. *_fts_docsize, sync_client_meta. Every probe is try/caught into the report.
- web/src/sync/replicaSync.ts: rebuildForCorruption gathers the report before recover('reset') and fire-and-forgets POST /api/client/diagnostics with {kind, error, report, client: {userAgent, standalone, visibility}}; post failures are swallowed.
- server routes_sync.py: POST /api/client/diagnostics, authenticated, logs one pkm.sync WARNING with the JSON body, returns {ok: true}. openapi.json + types.d.ts regenerated.
- docs: backend.md API row; sync-and-offline.md corruption trigger row.
- Fakes updated: memReplica, absentReplica, replicaSync/SyncProvider test fakes.
