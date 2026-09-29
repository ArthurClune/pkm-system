---
# pkm-9u3y
title: Strip bean ids from code comments; each comment states its rule
status: completed
type: task
priority: low
created_at: 2026-09-29T13:20:49Z
updated_at: 2026-09-29T13:20:49Z
parent: pkm-a4t2
---

Decision (Arthur, 2026-09-29): bean ids are banned from code comments as
they are from `docs/architecture/`. A comment states the rule; history lives
in git, the beans and `troubleshooting.md`. AGENTS.md gets the one-line rule
in the docs bean; this bean is the sweep.

Size at the decision: about 620 mentions across 167 runtime files and 440
across 94 test files. Mechanical but not blind: a comment that is only a
pointer is rewritten to state the rule it points at, or removed when the code
already says it; a test group named by bean id gets a behaviour name. No
behaviour change; typecheck, lint and the unit suites still run. Runtime code
first, then tests, one directory per lower-power agent, reviewed by diff.

## Todo

- [x] `server/src` sweep
- [x] `web/src` runtime sweep
- [x] test files sweep (group names included)
- [x] verify, merge

## Summary of Changes

Bean ids are gone from code and test comments across web/src (runtime and
tests), web/e2e, web/tooling, server/src, server/tooling and server/tests,
swept by directory in parallel worktrees (2026-09-29). Each comment that
cited a bean now states its rule; pure pointers were rewritten from the
bean or deleted where the code already says it; history notes kept only the
invariant; test and describe names that carried an id got behaviour names.
Generated files (openapi.json, types.d.ts, baseSchema.gen.ts) were
regenerated from their edited sources. Two CLI help epilogs said "created
before pkm-y5yv" and now say "created by an older version".

Left on purpose: strings that match the pattern but are not bean ids
(temp-file prefixes such as pkm-export-, backup filenames pkm-YYYY-MM-DD,
the OPFS name pkm-replica, the word "pkm-specific") and historical perf
reports under web/tooling. No behaviour change; server pytest, pyrefly,
ruff and pnpm verify pass on the merged tree.
