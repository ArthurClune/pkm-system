---
# pkm-svgx
title: 'Property checks: gate + server op invariants + Planner vs server'
status: completed
type: feature
priority: normal
created_at: 2026-10-02T10:57:25Z
updated_at: 2026-10-02T18:04:34Z
parent: pkm-nws9
---

proptest/check.sh gate (pytest marker proptest, excluded from pytest -q; Hypothesis merge profile), stateful server op invariants via /api/ops, and plan_batch -> apply_batch vs a position reference model. Spec: docs/superpowers/specs/2026-10-02-property-checks-server-design.md

## Summary of Changes

Shipped across five tasks: the `proptest/check.sh` gate (wrapper, `sides_for`, the `proptest` marker excluded from `pytest -q`'s `addopts`), the reference model (`props/model.py`, written from the docs rather than `ops_core`), two Hypothesis properties (`test_ops_state.py`'s stateful `OpsMachine` over `/api/ops`, `test_planner_props.py`'s CLI-batch-vs-server check), and the server strategies they share (`props/strategies.py`, `props/harness.py`).

Calibration (Task 5): `ops_state`'s `create` kind sat first in a `_weighted` option list, where Hypothesis's small-value draw bias picks the first option almost regardless of its nominal weight; every weight tried left per-submit 400s at 22-28%, because the 8-uid pool exhausts fast and a forced "uid already exists" then dominates. Moving `create` to the list's last (rare) slot let the weighting work, and easing the invalid-uid substitution from 1-in-50 to 1-in-150 brought real per-submit 400s to 9.0-13.3% across five direct measurements. The planner's concurrent-delete race went from 1-in-6 to 1-in-3 after repeatedly landing its `parent_not_found` coverage near the 2% floor. `MERGE_EXAMPLES` is now `{smoke: 4, ops_state: 420, planner: 1050}`; `proptest/check.sh server` measured 3:33, then 3:03, 2:56 and 3:05 across three confirmation runs, all inside the 2-4 minute band.

Docs: `docs/architecture/property-checks.md` (what each property checks, running it, reading a failure, the custom-`-m` trap, calibration), linked from `overview.md` and `AGENTS.md`'s doc list; an `AGENTS.md` § Testing bullet beside perf's. All 11 `DOC_GAPS.md` entries fixed in the doc section each named: `backend.md` §§ Missing targets, Conflicts, The write path and Concurrent structure edits (ack `skipped` reasons, uid-taken-outranks-diversion, the parent-uid-not-shape-checked-when-the-block-is-also-gone case, blank-text copies, create's heading/view_type/uncollapsed, title-syntax check scope, same-group move ordering); `sync-and-offline.md` § Conflicts at push time (evaluation order); `cli-and-mcp.md` § Pure planners' `index` table (fetch-time position counting, the Planner's known skip-simulation limit).

Mutation probes the two properties caught during Tasks 3 and 4 (not committed, reverted after each): `test_ops_state.py` caught a `create` with no `ShiftSiblings` effect (model/server order_idx disagreement) and a replay whose ack carried a fresh `ts` instead of the stored one; `test_planner_props.py` caught `batch.py` placing a create at a raw index instead of a minted key, and `Planner._land` without its sibling shift.

Final gates: `uv run pytest -q` (2373 passed), `uv run pyrefly check` (0 errors), `uv run ruff check` (clean), `proptest/check.sh server` (3 passed each run), `perf/check.sh backend` (no changes against the baseline -- product code untouched).
