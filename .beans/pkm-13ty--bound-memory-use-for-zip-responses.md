---
# pkm-13ty
title: Bound memory use for ZIP responses
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 26).

## Context

**References:** `server/src/pkm/server/routes_export.py:155-168`; `server/src/pkm/server/routes_assets.py:202-228`

Whole-graph and selected-asset exports build complete ZIPs in BytesIO and call getvalue(). Selected assets have no count or total-byte bound, so a large request can exhaust the process.

**Direction:** Use a temporary-file-backed or streaming response and enforce count/byte limits.

## Tasks

- [ ] Add archive size/count limit tests
- [ ] Verify temporary archive cleanup on cancellation/error
- [ ] Replace unbounded in-memory buffering
