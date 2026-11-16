---
# pkm-mnix
title: 'perfcheck: rebaseline doc assembly moves into run_core'
status: completed
type: task
priority: low
created_at: 2026-11-16T21:55:59Z
updated_at: 2026-11-16T22:17:19Z
---

An FCIS review of the merge-base rebaseline work found the plan is pure but the assembly is not. `server/tooling/perfcheck/run.py`'s `_rebaseline_docs` gets its decisions from `rebaseline_plan` and `base_servable` in `run_core.py`, then builds each run's baseline document itself: it starts from the merge-base run (or an empty copy of the head run when nothing runs at the base), merges in the branch-only scenarios from `branch_samples[min(i, len - 1)]`, and returns the carried committed entries. That merge is a data transformation sitting in the shell, tested only through the runner.

Aim: a pure `assemble_rebaseline_docs(base_docs, head_doc, branch_samples, plan, committed)` (name to taste) in `run_core.py` with unit tests covering no base scenarios, no branch-only scenarios, fewer branch samples than runs, and no usable committed baseline; `_rebaseline_docs` keeps only the runner calls.

- [x] Extract the assembly into `run_core.py` with unit tests
- [x] `_rebaseline_docs` calls it and only runs the harness
- [x] `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`


## Summary of Changes

`assemble_rebaseline_docs` in `server/tooling/perfcheck/run_core.py` now builds the rebaseline documents and the carried committed entries without mutating its inputs. `_rebaseline_docs` in `run.py` only makes the runner calls and the baseline reads, then calls it. Unit tests sit beside the `rebaseline_plan` test in `server/tests/test_perfcheck_run.py`.
