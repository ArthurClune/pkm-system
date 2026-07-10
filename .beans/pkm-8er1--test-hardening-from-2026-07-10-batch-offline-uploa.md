---
# pkm-8er1
title: 'Test hardening from 2026-07-10 batch: offline-upload preservation, multi-chunk upload, real-table concurrency'
status: todo
type: task
priority: low
created_at: 2026-07-10T12:21:55Z
updated_at: 2026-07-10T12:21:55Z
---

Follow-ups from the 2026-07-10 batch final-review triage — three test-strength gaps, behavior itself believed sound: (1) web/src/sync/connectionAware.test.tsx offline-upload test asserts only 'no POST'; also assert the op was preserved and flushes on reconnect; (2) no HTTP-level multi-MiB multi-chunk upload test (and mid-stream 413) through the real route — only the _stream_to_temp unit test covers multi-chunk logic; (3) server/tests/test_db_concurrency.py readers run SELECT 1, not a real table read, and join before the writer commits — read an actual table during the held write transaction to match the checklist wording.

## Checklist
- [ ] Strengthen offline-upload test: preservation + reconnect flush assertions
- [ ] HTTP-level large multi-chunk upload test + mid-stream 413 case
- [ ] Concurrency test reads a real table while the ops transaction is open/committing
- [ ] Suites green
