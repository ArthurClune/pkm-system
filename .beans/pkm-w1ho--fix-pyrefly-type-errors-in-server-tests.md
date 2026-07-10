---
# pkm-w1ho
title: Fix pyrefly type errors in server tests
status: completed
type: bug
priority: normal
created_at: 2026-07-10T10:01:16Z
updated_at: 2026-07-10T10:03:03Z
---

pyrefly check reports 12 errors across test_backlinks.py, test_edn.py, test_ops_core.py, test_tree.py, test_ws.py — dict.__init__ overload mismatches, indexing into object, and bad argument types.

## Summary of Changes

Fixed all 12 pyrefly errors (test-only changes, no runtime behaviour touched):

- tests/test_tree.py, tests/test_backlinks.py: replaced `dict(k=v)` constructor calls with dict literals — heterogeneous value types broke pyrefly's `dict.__init__` overload resolution.
- tests/test_edn.py: added `assert isinstance(db.value, dict)` to narrow `Tagged.value` (typed `object`) before indexing.
- tests/test_ops_core.py: switched raw-dict `OpBatch(...)` calls to `OpBatch.model_validate(...)` — the typed constructor expects parsed op models; model_validate is the idiomatic way to test payload parsing.
- tests/test_ws.py: `cast(WebSocket, conn)` when adding test-double connections to `hub._conns`.

Verified: `pyrefly check` → 0 errors; `uv run pytest` → 233 passed.
