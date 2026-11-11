---
# pkm-8w77
title: Run apply_batch off the event loop
status: scrapped
type: task
priority: deferred
created_at: 2026-10-26T16:13:08Z
updated_at: 2026-11-11T13:34:37Z
---

From the security/batch-server final review (M2). post_ops judges off the loop, but apply_batch runs on the event loop holding the write lock; linear in the request and bounded by the 64 MiB body cap (~28 s of apply for a dense 64 MiB batch), during which login and WebSockets stall. Move it to run_in_threadpool (the connection is check_same_thread=False; _stored_ack already runs there).

- [ ] Failing test: a WebSocket/login answers while a large batch applies
- [ ] run_in_threadpool(apply_batch, ...)
- [ ] backend.md § The write lock sentence updated


## Deferred (2026-10-27)

Arthur's ruling: only a session holder can send a batch large enough to stall the loop, and moving apply onto a thread pool while the loop shares the SQLite connection carries more risk than the stall. SECURITY.md lists it as a known limitation. Removed from the security epic.


## Reasons for Scrapping

Arthur already ruled that moving apply_batch to a thread pool, while the loop shares the SQLite connection, is riskier than the stall. Only a session holder can send a batch big enough to stall the loop, and it is listed as a known limitation. (Arthur, 2026-11-11.)
