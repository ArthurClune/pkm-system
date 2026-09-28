---
# pkm-95ss
title: Worker-filled base_text_hash makes the durable queue row diverge from the fallback-lane copy
status: todo
type: bug
created_at: 2026-09-28T21:08:34Z
updated_at: 2026-09-28T21:08:34Z
---

Found in the pkm-3g4n final-fix wave, and older than that branch. When an update_text reaches enqueueBatch (web/src/replica/queue.ts) without base_text_hash, the worker fills the hash into the durable row, but the in-memory fallback-lane copy keeps the original ops. If a reply is lost and the lane copy is replayed under the same batch_id, the server's request hash can differ and return 409, which poisons the row and shows the rejected-change banner. pkm-3g4n closed this for page_title by filling it only alongside a worker-filled hash, and pinned it with the queue.test.ts test 'a caller-hashed op is persisted exactly as the lane would keep it'. Fix: make the lane keep exactly the ops the worker persisted, for example by returning the stamped ops from enqueueBatch to the lane.
