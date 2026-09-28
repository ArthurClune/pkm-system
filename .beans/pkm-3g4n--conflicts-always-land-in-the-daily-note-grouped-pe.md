---
# pkm-3g4n
title: Conflicts always land in the daily note, grouped per block, naming the page
status: in-progress
type: feature
priority: normal
created_at: 2026-09-28T19:50:15Z
updated_at: 2026-09-28T21:11:37Z
---

Design approved 2026-09-28; spec docs/superpowers/specs/2026-09-28-conflicts-in-daily-note-design.md. Seen live: 13 queued edits of a never-created block produced six '[[conflict]] (original block deleted)' blocks on the daily note, none naming AI Agent Security.

Plan: docs/superpowers/plans/2026-09-28-conflicts-in-daily-note.md (5 tasks). Execution: subagent-driven. Children verbatim for now (Arthur, 2026-09-28).

## Todo
- [x] Task 1: contract field + pure conflict planning
- [x] Task 2: shell, conflict_headers table, endpoint, contract regen
- [x] Task 3: CLI/MCP page hint
- [x] Task 4: web stamps page_title
- [x] Task 5: docs, full verification, perf
- [x] Final whole-branch review (strongest model) incl. perf table
- [ ] Merge --no-ff, push, deploy (ask Arthur first)

## Summary of Changes

- Contract: `UpdateTextOp.page_title` is an optional hint that only labels a conflict. `find_op_title_violation` and `findOpTitleViolation` never validate it. When the hint is `None` it is left out of `batch_request_hash`, so batches stored before this change still replay to their stored ack. A golden-value test pins main's hashes.
- Server core (`ops_core.py`): `conflict_entry_effects` either appends under today's header for the block or creates one, and records it with `RecordConflictHeader`. The header takes one of three forms: `[[conflict]] [[Page]] — overwritten by ((uid))`, `… — edit to a block the server no longer has`, or `(page unknown)` for an unusable hint. The lost text is a verbatim child.
- Server shell (`ops_apply.py`, `schema.py`): new server-only table `conflict_headers(target_uid, day, header_uid)`, pruned to today whenever a header is recorded. `_conflict_header` ignores a header that was deleted or moved off the page. A clean hashed edit to a block that was never renamed skips the landing, so it never creates today's page.
- CLI/MCP: `edit_block` sends the fetched block's page title.
- Web: `stampBaseTextHashes` stamps `page_title` alongside the hash. The worker fills it only when it fills the hash itself, which keeps the durable row and the lane copy identical. `UnlinkedSection` sends it too. Undo history stays unstamped.
- Docs: backend.md, sync-and-offline.md, design.md, troubleshooting.md, the CLI help, and the pkm skill corrected from the sibling / `(original block deleted)` placement.
- Verified: server 1941 tests passed; pyrefly and ruff clean. Web `pnpm verify` passed (2667 unit, 62 e2e). `perf/check.sh` showed no changes against the baseline on backend or frontend.
- Follow-ups: pkm-x8e3 (a stale hint re-creates a renamed-away page), pkm-wy1v (pure-core predicate for the clean-edit shortcut), pkm-95ss (pre-existing: a worker-filled hash makes the durable row and the lane copy diverge).
