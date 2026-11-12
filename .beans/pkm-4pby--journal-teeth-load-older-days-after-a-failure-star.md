---
# pkm-4pby
title: 'journal teeth: ''Load older days after a failure starts from the head'' caught by done, not never-shrinks or days'
status: completed
type: bug
created_at: 2026-11-12T20:13:37Z
updated_at: 2026-11-12T20:13:37Z
---

A full proptest/check.sh web run on 2026-11-12 failed src/props/journal/teeth.prop.ts:

  × the journal property catches: Load older days after a failure starts from the head → mutant caught, but not by never-shrinks or days (seed 1070832070): done: false, model true (step 39) / pager: sentinel, model none

Deterministic on that seed. Cause: the mutant restarts an older load from the head. On a short journal the model's older load reaches the journal's start while the mutant's head reload does not, so the day count can match and only done (and pager, derived from it) differs. The mutant breaks done as well, and checks.md § Property gate says a mutant names every invariant its bug breaks.

## Summary of Changes

Added done to the mutant's catches in web/src/props/journal/teeth.prop.ts, with the comment saying when it is the only line. Swept seeds 1070832070, 1, 2, 3, 42, -7, 123456: all pass.
