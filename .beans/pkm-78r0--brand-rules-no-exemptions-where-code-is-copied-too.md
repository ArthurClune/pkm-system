---
# pkm-78r0
title: 'Brand rules: no exemptions where code is copied (tooling, perf harness, tests)'
status: todo
type: task
created_at: 2026-10-17T21:38:55Z
updated_at: 2026-10-17T21:38:55Z
---

Follow-up to pkm-zv2s. Aim: an agent finds it easy to do the right thing because (a) the code in its context is already right and (b) the rule is enforced. Review of the zv2s rulings against that aim found these gaps.

## Agreed changes
- [ ] Web perf harness under the brand rules: drop `web/tooling/perf/` from `brand_registry.TEST_SUPPORT` (ruling R19), regenerate, fix its ~15 brand casts (rebaseTargets.ts, rebase.perf.ts) with helpers or `select` reads.
- [ ] Server tooling under brandlint: widen scope from `server/src/**` to `server/tooling/**` (perfcheck, proptest, commentlint, brandlint). Register `server/tooling/perfcheck/` as the one tooling raw-sqlite site with its reason (it measures SQLite itself: trace and progress hooks, EXPLAIN plans).
- [ ] Delete the merge-base compatibility shims now that main has `pkm.database`: `getattr(con, "raw", con)` in perfcheck/trace.py and the `page_id`/`id` fallback in perfcheck/build.py. Every future merge base has the typed rows.
- [ ] proptest sync_server: replace the local `_dicts` helper with `Db.select`.

## Recommended, needs Arthur's call (reverses the spec's 'test code is exempt')
- [ ] Tests mint only through named test helpers, not blanket exemption: test-support modules become the tests' mint sites (`uidOf`, plus `pageIdOf`, `seqOf`, ... on the web; a Python twin in server/tests), and rules 1 and 2 apply to test files otherwise. Scale: ~600 brand casts in 65 web test files, ~600 brand constructor calls in 23 server test files (codemod).
- [ ] Test reads stop teaching casts: the ~160 `introspect(...) as T[]` web test reads move to `select<K>` where the columns are vocabulary keys, the rest to typed catalog/test helpers; server tests' `rawread.read` likewise moves to `select` for vocabulary columns.

## Optional
- [ ] `select<K>` is type-only: a K naming a column the SQL does not return types it as present. Under tests, check returned columns cover K (needs the keys at runtime, e.g. a keys argument). Medium cost: ~130 call sites.

## Related
- pkm-e9q8: the four ESLint plugin walk-arounds (predicate exemption, overload mint, launder variants, Record key) are enforcement holes; fix them before the Phase 2 merge.
- pkm-hc95: titles, the largest remaining loose-name area.
