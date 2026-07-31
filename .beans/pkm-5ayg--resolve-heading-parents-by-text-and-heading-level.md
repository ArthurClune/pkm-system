---
# pkm-5ayg
title: Resolve heading parents by text and heading level
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:54:55Z
updated_at: 2026-07-31T15:54:55Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 7.

**References:** server/src/pkm/cli/build.py:55-82,164-175,197-202

resolve_parent("## Notes") compares only block text and ignores heading. It can choose a plain Notes block or a level-3 heading instead of a level-2 heading, while same-batch heading memoization is level-aware.

**Direction:** Require the requested heading level when resolving heading specifications and define duplicate-heading selection semantics.

- [ ] Add plain-text collision, wrong-level collision, and duplicate-heading tests
- [ ] Align fetched-page and in-batch heading resolution
