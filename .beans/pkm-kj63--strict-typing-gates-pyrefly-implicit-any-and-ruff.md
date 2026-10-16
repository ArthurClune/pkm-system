---
# pkm-kj63
title: 'Strict typing gates: pyrefly implicit-any and ruff ANN on server/src; typescript-eslint no-unsafe on web'
status: completed
type: task
priority: normal
created_at: 2026-10-16T18:03:46Z
updated_at: 2026-10-16T18:38:02Z
---

Untyped data from outside (bare dict, missing annotations, Any) hid the GoodLinks 500s fixed in pkm-6rx1: nothing forced the shape check. Turn the gates on and fix every existing violation rather than baselining.

- [x] pyrefly.toml sub-config: implicit-any-type-argument, implicit-any-parameter, implicit-any-empty-container on server/src/**
- [x] ruff ANN on server/src (tests/tooling exempt)
- [x] Fix server/src/pkm/server routes and HTTP layer
- [x] Fix server/src/pkm/server core (grouping, ops_apply, tree, query, ops_*)
- [x] Fix server/src outside pkm/server
- [x] web eslint: no-unsafe-assignment/member-access/return/argument/call, no-explicit-any, with lintConfig fixtures
- [x] Mutation check: reinsert the bug classes, gates fail
- [x] Final review, full gates

## Summary of Changes

- Gates: pyrefly implicit-any-type-argument/parameter/empty-container are errors for server/src (pyrefly.toml sub-config); ruff ANN on server/src (tests/tooling exempt); web eslint no-explicit-any plus five no-unsafe-* rules, each with a lintConfig fixture.
- Fixed every existing violation (about 225 pyrefly, 36 ruff, 3 eslint) rather than baselining. Rows from our own schema are `SchemaRow` (pkm/schema.py); TreeNode and grouping TypedDicts carry the DDL's column types; external data is `object` and narrowed.
- Mutation-checked: a missing return annotation, bare dict, untyped param, `any` and untyped JSON.parse each fail a gate.
- Verified: pytest 2795 passed (97.61%), pyrefly 0, ruff clean, pnpm verify (81 e2e) passed, perf no changes, proptest server passed, Opus whole-branch review (0 blockers; should-fix items done).
- Follow-ups filed separately; brand-typed row fields noted on pkm-zv2s.
