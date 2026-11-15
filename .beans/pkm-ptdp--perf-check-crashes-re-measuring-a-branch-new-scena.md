---
# pkm-ptdp
title: perf check crashes re-measuring a branch-new scenario at the merge base
status: todo
type: bug
priority: normal
created_at: 2026-11-15T18:18:18Z
updated_at: 2026-11-15T22:02:08Z
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
