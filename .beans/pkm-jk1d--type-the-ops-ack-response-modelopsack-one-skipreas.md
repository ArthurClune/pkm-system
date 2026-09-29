---
# pkm-jk1d
title: 'Type the ops ack: response_model=OpsAck, one SkipReason, a typed reader in opQueue'
status: todo
type: task
priority: normal
created_at: 2026-09-29T13:20:41Z
updated_at: 2026-09-29T13:21:11Z
parent: pkm-a4t2
blocked_by:
    - pkm-6xza
---

Review contract gap, agreed by both reviews. `OpsAck` is not a
`response_model` on `POST /api/ops`, so `opQueue.ts` reads `seq` and `skipped`
from `unknown` by hand; `SkipReason` is declared in `ops_core.py` and again in
`responses.py` with no equality test; two `opQueue.replica.test.ts` fixtures
use `reason: "missing_target"`, which is not a `SkipReason`; the
`responses.py` comment still says the browser reads only the ack's optional
`seq`; `client/workflows.py`, `docs/cli.md` and `cli/main.py` omit
`parent_not_found` from their skipped-op wording. The fix must keep reading
acks stored before it: `seq` may be absent (unknown, so refetch) and a missing
`skipped` means empty.

Design: spec § Typed ack. Blocked by F5, which extends the hand reader this
task replaces.

## Todo

- [ ] `response_model=OpsAck`; test that a replayed stored ack without `seq` serializes `seq: null` and `skipped: []` on the wire
- [ ] `SkipReason` declared once in `contracts/responses.py`, imported by `ops_core.py`
- [ ] Regen `openapi.json` and the web types; one typed reader in `opQueue.ts` tolerating a missing `seq` or `skipped`, replacing `ackSeq` and `ackSkipped`; test over an ack missing either field
- [ ] Fixtures → `block_not_found`; `responses.py` comment; `parent_not_found` in `client/workflows.py`, `docs/cli.md`, `cli/main.py`
- [ ] Docs: `backend.md` API table (response model; D5: `batch_id` required, minimum length 8, 422 without)
- [ ] verify, perf, merge
