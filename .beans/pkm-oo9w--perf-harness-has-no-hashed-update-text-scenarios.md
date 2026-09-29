---
# pkm-oo9w
title: Perf harness has no hashed update_text scenarios
status: completed
type: task
priority: normal
created_at: 2026-09-28T22:40:50Z
updated_at: 2026-09-29T10:49:24Z
---

Found in pkm-wy1v. perf/check.sh backend's only /api/ops update_text scenario (ops/edit-1) sends no base_text_hash, so it exercises the legacy hashless path. Nothing measures the hashed paths: clean, identical, conflict (daily-page landing), rename replay, or pkm-foap's missing-target landings. pkm-wy1v's query savings are therefore unmeasured. Add hashed scenarios to the harness and bootstrap their baselines.

## Summary of Changes

Added 7 backend scenarios to `server/tooling/perfcheck/backend.py`'s `scenarios()`, all under `POST /api/ops`:

- `ops/edit-hashed-clean` — hashed edit, `base_text_hash` matches current text, new text differs → `ops_core.classify_text_edit` returns `clean`.
- `ops/edit-hashed-identical` — hashed edit, sent text equals current text → `classify_text_edit` returns `identical` (zero write effects).
- `ops/edit-hashed-conflict` — hashed edit with a deliberately stale hash → `classify_text_edit` returns `conflict`; loser lands under today's frozen-clock daily-note conflict header, incoming text wins.
- `ops/edit-rename-replay` — hashed edit predating a seeded rename, targeting a block with a `block_rewrites` row → exercises `ops_core.replay_title_rewrites`, applies cleanly onto the renamed text.
- `ops/edit-missing-block` — `update_text` on a uid the fixture never creates → `ops_core.classify_missing_target`'s `orphan_edit`, text lands under a conflict header.
- `ops/create-missing-parent` — `create` under a nonexistent parent → `diverted_create`, text lands instead of the block.
- `ops/move-missing-parent` — `move` to a nonexistent parent → `move_parent_missing`, block stays put, its subtree is journalled.

Seeding, in `server/tooling/perfcheck/fixture.py` and `build.py`:

- `HASHED_EDIT_TEXT` is planted verbatim on a dedicated block (`Landmarks.hashed_edit_uid`), added after every random sample in `generate()` so it can never drift.
- A `Landmarks.rename_ref_uid` block references a page (`RENAME_SOURCE_TITLE`) that `build.py` renames once, directly through `store.rename_page_rows` (rename is a route, not an op batch), leaving a real `block_rewrites` row for the replay scenario.
- `MISSING_BLOCK_UID` / `MISSING_PARENT_UID` are fixed uids in a prefix (`ghost*`) the generator's own uid schemes (`f<11 digits>`, `pp<8 digits>`) never produce.

This changes `fixture_hash` (fixture.py changed), so both backend and frontend baselines need `perf/check.sh <side> --rebaseline` before the next check passes (per `AGENTS.md`: a fixture change rebaselines, it doesn't bootstrap). Left for the orchestrator to run on a quiet machine.

Verification: all 4 classifications (clean/identical/conflict/rename-replay-clean) confirmed directly against `ops_core.classify_text_edit`; ran `python -m perfcheck.backend` twice at full scale and diffed every new scenario's non-timing metrics — identical both times. New pytest coverage in `test_perfcheck_fixture.py`, `test_perfcheck_build.py` (block_rewrites row shape) and `test_perfcheck_backend.py` (one test per new scenario, asserting the resulting DB state matches the intended branch, not just that a count came back). Full `uv run pytest -q`, `ruff check`, `pyrefly check` all pass. `docs/architecture/performance-checks.md`'s Writes scenario row and a short mechanism note updated; `check-docs.mjs` clean.


Baselines re-recorded with `perf/check.sh backend --rebaseline` and `frontend --rebaseline` on a quiet machine (the fixture change moved fixture_hash for both sides); confirming `perf/check.sh backend` / `frontend` both report no changes.
