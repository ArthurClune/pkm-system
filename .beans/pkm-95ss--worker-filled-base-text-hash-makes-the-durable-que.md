---
# pkm-95ss
title: Worker-filled base_text_hash makes the durable queue row diverge from the fallback-lane copy
status: completed
type: bug
created_at: 2026-09-28T21:08:34Z
updated_at: 2026-09-28T21:08:34Z
---

Found in the pkm-3g4n final-fix wave, and older than that branch. When an update_text reaches enqueueBatch (web/src/replica/queue.ts) without base_text_hash, the worker fills the hash into the durable row, but the in-memory fallback-lane copy keeps the original ops. If a reply is lost and the lane copy is replayed under the same batch_id, the server's request hash can differ and return 409, which poisons the row and shows the rejected-change banner. pkm-3g4n closed this for page_title by filling it only alongside a worker-filled hash, and pinned it with the queue.test.ts test 'a caller-hashed op is persisted exactly as the lane would keep it'. Fix: make the lane keep exactly the ops the worker persisted, for example by returning the stamped ops from enqueueBatch to the lane.

**Correction (investigation before this fix):** the suggested fix above does
not work. There is no reply to carry stamped ops back to the lane in the
failure case this bean describes — the RPC reply is what got lost, and the
durable row can even arrive after a tab reload, once the in-memory lane is
already gone. Either copy (durable or fallback-lane) can also arrive at the
server first. A client-side "hand the stamped ops back" fix has nothing to
attach the fix to. The real fix has to be server-side: tolerate the
divergence in the hash the server uses to recognize a replay, since
`base_text_hash`/`page_title` are guard/label metadata that never change
which op is applied.

## Summary of Changes

Implemented the server-side fix instead of the bean's original suggestion:

- `server/src/pkm/server/ops_core.py`: added `batch_replay_hash` (and a
  `_canonical_replay_op` helper), identical to `batch_request_hash` except it
  drops `base_text_hash`/`page_title` from every `update_text` op before
  hashing. `batch_request_hash` and `_canonical_op` are untouched byte-for-byte.
- `server/src/pkm/server/routes_ops.py`: `applied_batches.request_hash` now
  stores the replay hash for newly-inserted rows. On lookup, a stored hash is
  accepted if it equals either the strict hash or the replay hash of the
  incoming batch, so a pre-deploy row (strict hash) still replays and a
  post-deploy row (replay hash) tolerates the worker-filled fields. The
  concurrent-insert `IntegrityError` path is unchanged.
- Tests (TDD, all written first and confirmed failing before the fix):
  `server/tests/test_ops_idempotency.py` gained unit tests for
  `batch_replay_hash` (ignores the two fields; still differs for a real
  payload/uid/op-type/extra-op change) and four route-level tests: worker-filled
  → bare replay, bare → worker-filled replay, a genuine payload change under
  the same `batch_id` still 409s even with guard fields present, and a
  directly-inserted pre-deploy row holding the strict hash still replays and
  still 409s on a real change.
- Client: `web/src/replica/queue.ts` and `web/src/outline/baseTextHash.ts`
  comments updated to say the server's replay hash tolerates the divergence,
  rather than claiming byte-identical copies are required to avoid a 409.
  `queue.test.ts`'s "a caller-hashed op is persisted exactly as the lane would
  keep it" test is unchanged (it still documents the byte-identical case) and
  no client behaviour changed.
- Docs: `docs/architecture/backend.md` (Idempotency bullet) and
  `docs/architecture/sync-and-offline.md` (`base_text_hash`/`page_title`
  paragraph) updated to describe `batch_replay_hash` and why a stored hash can
  be either kind. One row added to `docs/troubleshooting.md` under Backend.
- No route docstring changed, so no OpenAPI/type regen was needed.

Verification: `cd server && uv run pytest -q` — 1947 passed, 97.36% coverage
(≥95% required). `uv run pyrefly check` — 0 errors. `uv run ruff check` — all
checks passed. `cd web && pnpm typecheck` — clean. `pnpm vitest run
src/replica/queue.test.ts src/outline/baseTextHash.test.ts` — 25 passed.
