---
# pkm-gwwu
title: POST /api/ops reads a batch's context in autocommit, so a concurrent delete swallows the text under an ok ack
status: todo
type: bug
priority: high
created_at: 2026-09-29T13:20:27Z
updated_at: 2026-09-29T13:20:27Z
parent: pkm-a4t2
---

Review F2 (P1, pre-existing, widened). `open_db` sets neither
`isolation_level` nor `autocommit`, so Python's `sqlite3` module begins the
implicit transaction at the first write. In `post_ops` the `applied_batches`
read and op 0's context reads run in autocommit, while `delete_page`,
`rename_page` and `cleanup_journal` are plain `def` routes committing from the
threadpool. A page deletion committing between the context read and the
`UPDATE`: the update matches zero rows, no trigger fires, `TouchPage` matches
nothing, the route stores `ok` and every retry replays it. The text is in no
block, no conflict entry and no daily note. Had the delete landed before the
read, `classify_missing_target` would have made it an orphan edit on the
daily page. (Text carrying a ref, tag, attribute or block ref hits the FK,
500s and recovers on retry.) A rename in the window resurrects the old title
with a 200. Likeliest trigger: journal cleanup deleting a recent empty daily
page while another client types the first text into it.

Design: spec § F2 — `BEGIN IMMEDIATE` first in `post_ops`, following
`routes_sidebar.py`; every exit ends the transaction; a lock the busy timeout
cannot take returns 503 with `Retry-After`; the unreachable `IntegrityError`
branch goes.

## Todo

- [ ] Rewrite `test_ops_idempotency.py`'s injected-commit test: the second connection (short busy timeout) is shown to block and the batch is unaffected
- [ ] New tests through `POST /api/ops` with a second connection: a page deleted before the route lands the text on today's daily page; a rename before the route cannot resurrect the old title
- [ ] `BEGIN IMMEDIATE` before the dedupe read; replay and error paths roll back; lock timeout → 503; remove the `IntegrityError` branch
- [ ] Docs D1: `routes_ops.py` docstring (regen `openapi.json`), `backend.md` § The write path, the `sync-and-offline.md` one-transaction line; troubleshooting row
- [ ] verify, perf, merge
