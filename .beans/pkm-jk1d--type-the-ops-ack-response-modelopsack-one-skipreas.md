---
# pkm-jk1d
title: 'Type the ops ack: response_model=OpsAck, one SkipReason, a typed reader in opQueue'
status: completed
type: task
priority: normal
created_at: 2026-09-29T13:20:41Z
updated_at: 2026-09-29T16:10:14Z
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

- [x] `response_model=OpsAck`; test that a replayed stored ack without `seq` serializes `seq: null` and `skipped: []` on the wire
- [x] `SkipReason` declared once in `contracts/responses.py`, imported by `ops_core.py`
- [x] Regen `openapi.json` and the web types; one typed reader in `opQueue.ts` tolerating a missing `seq` or `skipped`, replacing `ackSeq` and `ackSkipped`; test over an ack missing either field
- [x] Fixtures → `block_not_found`; `responses.py` comment; `parent_not_found` in `client/workflows.py`, `docs/cli.md`, `cli/main.py`
- [x] Docs: `backend.md` API table (response model; D5: `batch_id` required, minimum length 8, 422 without)
- [ ] verify, perf, merge

## Summary of Changes

- `POST /api/ops` now declares `response_model=OpsAck`. A replayed stored ack
  passes through the model like a fresh one, so an ack stored before `seq`
  existed replays `seq: null` (read as unknown) and one stored before
  `skipped` existed replays `skipped: []`. This is additive-only on the wire:
  every prod ack is one of the two pre-existing shapes, and every deployed
  reader already tolerates a missing/null `seq` and a missing `skipped`.
- `SkipReason` is now declared once, in `contracts/responses.py`;
  `ops_core.py` and `render.py` import it instead of redeclaring it. A
  shared fixture (`shared/fixtures/ops_acks.json`) pins the
  stored-ack-to-wire mapping and the three `SkipReason` values, replayed on
  both the server (`test_ops_idempotency.py`) and the web
  (`opsAck.test.ts`, `opsAck.composed.test.ts`).
- Web: `readOpsAck` in `web/src/sync/opsAck.ts` replaces `ackSeq` and
  `ackSkipped` as the one typed reader every ack caller uses (the lane, the
  drain, and `replicaSync`'s recovery flush), reading through the generated
  `OpsAck`/`SkippedOp` types (`web/src/api/payloads.ts`).
- Four test fixtures (not two, as the review counted) used
  `reason: "missing_target"`, which is not a `SkipReason`: three in
  `opQueue.replica.test.ts`, one in `SyncProvider.test.tsx`. All four are
  now `block_not_found` and annotated `satisfies OpsAck` so a future
  `SkipReason` drift fails the type check, not just at runtime.
- Wording: `client/workflows.py`, `cli/main.py`, `mcp/server.py` and
  `docs/cli.md` now name `parent_not_found` (a create/move whose parent no
  longer exists) alongside the uid-not-found and cycle cases they already
  named.
- Docs: `backend.md`'s `/api/ops` API-table row now names the response
  model and describes `seq`/`skipped` as always-present fields, dropping
  the old "present only when non-empty" wording; the write-path intro
  states `batch_id` is required (8-64 chars, 422 without) instead of
  "optional"; a new Generated-artifacts row documents
  `shared/fixtures/ops_acks.json`. `frontend.md`'s module map entry for
  `opsAck.ts` now names `readOpsAck` and the generated `OpsAck` type.
- Note for the orchestrator: `perf/check.sh backend` will report `bytes`
  +13 on every clean `ops/*` scenario (`ops/edit-1`, `ops/edit-hashed-*`,
  `ops/edit-rename-replay`, `ops/move-subtree`, `ops/paste-50`) because a
  clean ack now carries `"skipped":[]` on the wire; the skipping scenarios
  are unchanged. That is this wire change, not a regression to fix. Per
  AGENTS.md this needs Arthur's acceptance, then
  `perf/check.sh backend --bootstrap`, with the reason in the commit
  message.
- Verified on the real route (TestClient) that all four wire shapes match
  the plan exactly: a clean ack (`skipped: []`, integer `seq`), a skipped
  ack (`skipped` naming `block_not_found`), a replayed stored ack from
  before `seq`/`skipped` existed (`seq: null, skipped: []`), and the
  409/400 error bodies (unchanged `{index, reason}` detail shape).
