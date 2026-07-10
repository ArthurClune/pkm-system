---
# pkm-8er1
title: 'Test hardening from 2026-07-10 batch: offline-upload preservation, multi-chunk upload, real-table concurrency'
status: completed
type: task
priority: low
created_at: 2026-07-10T12:21:55Z
updated_at: 2026-07-10T12:36:27Z
---

Follow-ups from the 2026-07-10 batch final-review triage — three test-strength gaps, behavior itself believed sound: (1) web/src/sync/connectionAware.test.tsx offline-upload test asserts only 'no POST'; also assert the op was preserved and flushes on reconnect; (2) no HTTP-level multi-MiB multi-chunk upload test (and mid-stream 413) through the real route — only the _stream_to_temp unit test covers multi-chunk logic; (3) server/tests/test_db_concurrency.py readers run SELECT 1, not a real table read, and join before the writer commits — read an actual table during the held write transaction to match the checklist wording.

## Checklist
- [x] Strengthen offline-upload test: preservation + reconnect flush assertions
- [x] HTTP-level large multi-chunk upload test + mid-stream 413 case
- [x] Concurrency test reads a real table while the ops transaction is open/committing
- [x] Suites green

## Summary of Changes

Test-only hardening; no production code changed (nothing revealed a real bug).

- `web/src/sync/connectionAware.test.tsx`: test (b) ("an image upload
  completing after disconnect...") now matches test (c)'s pattern instead of
  only asserting zero POSTs. It resolves the upload while offline, confirms
  no POST fires, then advances the fake reconnect timer, reopens the fake
  socket, and asserts exactly one flushed POST whose op is
  `{ op: "update_text", uid: "u1", text: "![pic.png](/assets/abc/pic.png)" }`
  — proving the op was preserved (not dropped) and flushed in order on
  reconnect.
- `server/tests/test_asset_upload.py`: added
  `test_upload_multi_chunk_http_roundtrip` (a 3 MiB body posted through the
  real `/api/assets` TestClient route, spanning multiple 1 MiB
  `_stream_to_temp` chunks, asserting sha256/size/stored bytes match) and
  `test_upload_mid_stream_413_over_multiple_chunks_leaves_no_tmp_file` (a
  3 MiB body against a 1.5 MiB cap so the 413 fires on the second chunk,
  asserting the status code and that no temp/partial file is left in
  `assets_dir`). Both drive the real HTTP route rather than the
  `_stream_to_temp` unit directly.
- `server/tests/test_db_concurrency.py`: strengthened
  `test_concurrent_open_db_calls_survive_an_in_flight_ops_transaction` so
  the 8 reader threads run `SELECT COUNT(*) FROM blocks` (a real table)
  instead of `SELECT 1`, and rendezvous on a 9-party `threading.Barrier`
  (8 readers + main) so the main thread's own `wait()` only returns once
  every reader is at its read — a structural proof the reads overlap the
  writer's still-open transaction, since `writer.commit()` only runs after
  that barrier and after all reader threads join. Asserts all 8 readers see
  `0` rows (the pre-transaction snapshot), not the writer's pending insert.
- Verification: `cd server && uv run pytest -q` (278 passed), `uv run ruff
  check` (clean), `uv run pyrefly check src tests` (0 errors — see note
  below); `cd web && pnpm test -- --run` (268 passed) and `pnpm typecheck`
  (clean).
- Note: `uv run pyrefly check` (no path arg) from `server/` spuriously
  excludes `server/src` in this worktree, because the whole checkout lives
  under `.claude/worktrees/...`, which the root `.gitignore` lists
  (`.claude/worktrees/`) — pyrefly's ignore-file matching treats the
  checkout itself as ignored. Passing explicit paths
  (`uv run pyrefly check src tests`) works around it and reports 0 errors.
  Not a defect introduced by this change; worth a footnote for future
  worktree sessions.
