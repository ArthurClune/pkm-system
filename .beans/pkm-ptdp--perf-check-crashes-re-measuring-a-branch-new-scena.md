---
# pkm-ptdp
title: perf check crashes re-measuring a branch-new scenario at the merge base
status: completed
type: bug
priority: normal
created_at: 2026-11-15T18:18:18Z
updated_at: 2026-11-16T14:02:25Z
---

Symptom: `perf/check.sh backend` exits 2 with
`RuntimeError: query/records: HTTP 404 {"detail":"Not Found"}` and
`## perf: backend failed — Command '[... perfcheck.backend ... --commit d8b7eb5 --only ...,query/records]'`.

Cause: `run.py` `check()` re-measures surviving regressions at the merge-base
worktree (`merge_base_worktree`) with the branch's own tooling. A scenario
added on the branch (here `query/records`, recorded into the branch baseline
by an earlier check) does not exist in the merge base's server, so the route
404s and the whole check fails instead of reporting the scenario.

Expected: a scenario the merge base cannot serve is judged without a merge-base
measurement (e.g. skipped from the `--only` list, outcome "regression" against
the branch baseline), and the table is still printed.

Found on feat/tables-and-queries when `/api/query/records` gained `read_txn`
(statements 6 -> 8: BEGIN + ROLLBACK).

## Summary of Changes

Symptom: `perf/check.sh backend` exits 2 with `RuntimeError: query/records: HTTP 404 {"detail":"Not Found"}` and `## perf: backend failed`, when a surviving regression is a scenario the branch added.

Cause: `do_check` re-measured every survivor at the merge-base worktree, whose server has no route for a branch-new scenario.

Fix: `run_core.base_servable` keeps only scenarios present in the merge base's own committed `perf/baseline-<side>.json` (deterministic, no 404 catch; a missing or malformed base baseline drops nothing). Dropped scenarios get no merge-base run and are judged against the branch baseline, so the table still prints. Rule: docs/architecture/checks.md § Performance gate.

Frontend: a scenario's whole context group is dropped (groups parsed from `contextGroups.ts`), since check.ts runs a group together.

`--rebaseline`: one full harness run on the branch first learns which scenarios exist. A scenario the merge base cannot run keeps its committed branch entry unchanged, so a branch regression never becomes the baseline. It is measured on the branch, `runs` times with that run as the first sample, only when it has no usable committed entry (absent, or the baseline is incomparable). A contextGroups.ts or branch baseline that cannot be read fails with `## perf: <side> failed` and exit 2.
