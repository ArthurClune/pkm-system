---
# pkm-zv2s
title: 'Brand check: brand-named params must use the brand; brands minted only at declared sites'
status: completed
type: feature
priority: normal
created_at: 2026-10-16T18:03:46Z
updated_at: 2026-10-19T09:13:28Z
---

A type checker cannot catch a GoodlinksId passed through a str parameter (pkm-6rx1). Add a brand registry naming, per brand, its mint sites and the parameter/field names that must carry it. Two rules: (1) a parameter or field with a registered name must use the brand (line-level opt-out for untrusted route params that are parsed); (2) the brand constructor / `as Brand` cast appears only in its mint files and tests. Server: Python AST rule in the commit-time check being added alongside the comment check (bean ids / line numbers in comments). Web: eslint no-restricted-syntax selectors generated from the same registry, with lintConfig fixtures. Must also run from pytest and pnpm verify, not only the commit hook. Wait for the comment-check work to land, then build into its framework.

## Related (from pkm-kj63 review)

tree.TreeNode and grouping's TypedDicts type uid/view_type/order_idx/heading as str/int while contracts.BlockNode uses BlockUid, ViewType, OrderIdx, StoredHeading. Minting brands at row reads belongs with this check. grouping.GroupItem (TypedDict) also shares its name with contracts.responses.GroupItem (pydantic): rename one.

## Plan

Spec: docs/superpowers/specs/2026-10-17-brand-check-design.md
Plan: docs/superpowers/plans/2026-10-17-brand-check.md

- [x] Task 1: registry and row vocabulary
- [x] Task 2: the Db wrapper, everywhere
- [x] Task 3: server core reads through select
- [x] Task 4: routes read through select and return their models
- [x] Task 5: reads outside pkm/server
- [x] Task 6: narrow Db.execute
- [x] Task 7: rule 1 on the server
- [x] Task 8: rule 2, escape hatches, connection rule (server)
- [x] Task 9: server docs, gates, phase review, merge
- [x] Task 10: generated columns and registry for the web
- [x] Task 11: column-named select and the web row check
- [x] Task 12: ESLint brands plugin
- [x] Task 13: fix every web violation
- [x] Task 14: web docs, gates, final review


## Status 2026-10-17
- Phase 1 (Tasks 1-9) merged to local main as 466c6a5d (not pushed, not deployed).
- Phase 2 (Tasks 10-13) done on feat/brand-check-web; Task 14 docs, gates and final review done; the merge is held: Arthur decided pkm-78r0 (no brand-rule exemptions for tooling, the perf harness or tests) and the first four items of pkm-e9q8 (plugin walk-arounds) land on the branch first.


## Summary of Changes

Phase 1 (server: names carry their brand, rows arrive branded, brandlint) merged as 466c6a5d. Phase 2 on feat/brand-check-web: generated columns and registry for the web, column-named `select` and a test-only row check, the ESLint brands plugin (no brand assertions, laundering walk-arounds, names carry the brand, type-aware lint), every web violation fixed, then pkm-78r0 (no exemptions for tooling, perf harness or tests) and the first four pkm-e9q8 plugin walk-arounds. Gates: server pytest/pyrefly/ruff/sweep, web verify, proptest both sides, perf rebaselined at the merge base with no changes. Residual walk-arounds: pkm-e9q8, pkm-iqxv.
