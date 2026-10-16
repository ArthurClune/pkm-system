---
# pkm-kj63
title: 'Strict typing gates: pyrefly implicit-any and ruff ANN on server/src; typescript-eslint no-unsafe on web'
status: in-progress
type: task
priority: normal
created_at: 2026-10-16T18:03:46Z
updated_at: 2026-10-16T18:03:52Z
---

Untyped data from outside (bare dict, missing annotations, Any) hid the GoodLinks 500s fixed in pkm-6rx1: nothing forced the shape check. Turn the gates on and fix every existing violation rather than baselining.

- [x] pyrefly.toml sub-config: implicit-any-type-argument, implicit-any-parameter, implicit-any-empty-container on server/src/**
- [x] ruff ANN on server/src (tests/tooling exempt)
- [ ] Fix server/src/pkm/server routes and HTTP layer
- [ ] Fix server/src/pkm/server core (grouping, ops_apply, tree, query, ops_*)
- [ ] Fix server/src outside pkm/server
- [ ] web eslint: no-unsafe-assignment/member-access/return/argument/call, no-explicit-any, with lintConfig fixtures
- [ ] Mutation check: reinsert the bug classes, gates fail
- [ ] Final review, full gates
