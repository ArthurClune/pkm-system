---
# pkm-vh0f
title: 'perf harness: frontend rebaseline dies when the branch harness imports a pkm module the merge base lacks'
status: completed
type: bug
priority: normal
created_at: 2026-10-19T08:44:06Z
updated_at: 2026-10-19T12:46:11Z
---

`perf/check.sh frontend --rebaseline` runs this branch's harness (e2e_serve.py and what it imports, including server/tests/fake_engine.py) against the merge base's `pkm` package. When a branch makes that harness chain import a `pkm` module the merge base lacks, the merge-base fixture server dies at import (seen on feat/brand-check-web: fake_engine.py imports `pkm.test_data.ids`, new on the branch; "fixture server exited with 1", ModuleNotFoundError). The rebaseline then cannot run at all, and the only documented way out is `--bootstrap`, which gives up the comparison with main.

Worked around on that branch with an uncommitted try/except import shim in fake_engine.py for the rebaseline and check runs (inert on the branch).

- [x] Decide the invariant: the merge-base harness chain imports only `pkm` modules present at the merge base, or the harness detects the import failure and says so (naming the module) instead of "fixture server exited with 1"
- [x] Enforce or document it (perfcheck run.py docstring / docs/architecture/performance-checks.md)

## Summary of Changes

Rule: the branch's perf harness may import only `pkm` names the merge base has; branches are not forbidden from adding such imports. Instead a merge-base run that dies importing one now stops with a message naming the import and the way out: land the module on main first, or `perf/check.sh <side> --bootstrap`.

- run_core.py: `missing_pkm_import` (ModuleNotFoundError / ImportError, pkm only) and `missing_import_advice`.
- run.py: the backend run, fixture_path and the fixture server all route failures through the detector.
- Docs: performance-checks.md (paragraph under the merge-base table, Extending row), troubleshooting row.
