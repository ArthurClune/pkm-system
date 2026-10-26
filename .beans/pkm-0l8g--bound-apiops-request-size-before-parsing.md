---
# pkm-0l8g
title: Bound /api/ops request size before parsing
status: completed
type: bug
priority: low
created_at: 2026-10-25T02:14:31Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf plan open risks (2026-10-25). A 500-op batch of 1,000,000-character texts (500M chars, ~2 GB as JSON) is read into memory before the text-limit guard. Related: pkm-zav2 (auth before body). Add a request-body byte cap for /api/ops sized from MAX_OPS_PER_BATCH x MAX_BLOCK_TEXT_CHARS plus overhead, or a streaming refusal.

- [x] Decide the cap from real batch sizes
- [x] 413 before parsing; test
- [x] troubleshooting.md row

## Summary of Changes

- Behaviour: authenticated request bodies are capped at 64 MiB (PRIVATE_BODY_MAX_BYTES, shared/fixtures/batch_limits.json beside max_ops_per_batch 500) in the auth gate before parsing: declared length past the cap is refused 413 unread; no length or chunked framing (Transfer-Encoding beats Content-Length in h11) falls to a counted read that stops at the cap. POST /api/assets is exempt from the 64 MiB cap but is capped at max_upload_bytes plus a small multipart envelope. The web refuses a command whose batch would exceed 500 ops or the cap with a notice instead of queuing it (batchLimits.ts), releasing fresh uploads; long pastes over 500 lines, previously lost, are fixed.
- Commits: 1ff439f9 (server cap), aa98e8bf (upload cap), 30fdf394/42f855e9 (web size refusal, Task 10). Troubleshooting rows for the ops-body and upload-body failures and the paste loss.
- Rulings: Arthur 2026-10-25: 64 MiB for all authenticated bodies except uploads; web refuses >500 ops or the cap with the notice; long pastes fixed. Orchestrator: upload route capped in the gate (its own rule ran only after buffering; cost: an upload just past the limit gets the gate's 413). Task 10 Minors 2-3 (per-op 1,024 allowance under-counts long titles near the cap) went to ax2j, once titles are <=1,000 characters.
- Follow-ups: pkm-qgjs; a Task 10 test gap (size refusal with a separate pending draft) was parked.
