---
# pkm-9u3y
title: Strip bean ids from code comments; each comment states its rule
status: todo
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

- [ ] `server/src` sweep
- [ ] `web/src` runtime sweep
- [ ] test files sweep (group names included)
- [ ] verify, merge
