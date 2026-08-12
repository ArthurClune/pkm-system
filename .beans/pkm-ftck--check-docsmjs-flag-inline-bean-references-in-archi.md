---
# pkm-ftck
title: 'check-docs.mjs: flag inline bean references in architecture docs prose'
status: completed
type: task
priority: normal
created_at: 2026-08-12T20:59:16Z
updated_at: 2026-08-12T21:01:51Z
---

Follow-up to pkm-n98j. Fold the bean-ref-in-prose detector into .claude/skills/architecture-docs/check-docs.mjs so every doc edit catches regressions at write time instead of waiting for a /check-arch-docs audit. Bean ids are legitimate only in symptom-table rows (lines ending |), linked spec filenames, and known product uses (pkm-replica, pkm-specific). Update architecture-docs and check-arch-docs SKILL.md so the exclusion list lives only in the script.

## Summary of Changes

`checkBeans` added to check-docs.mjs: bean ids in prose are now a hard FAIL (exit 1) alongside broken diagrams and links. Exclusions live only in the script — table rows (trimmed leading |) and superpowers/specs|plans paths; product names (pkm-replica, pkm-specific) never match because the id shape ends at a word boundary. Code blocks are blanked line-for-line so reported line numbers stay right.

Tested RED (pre-change script silent on a seeded ref), GREEN (seeded ref fails at the right line; the two real pre-fix frontend.md violations from 6e06dea fail at lines 213/453; all seven current docs pass, exit 0). architecture-docs and check-arch-docs SKILL.md updated: the audit's mechanical sweep now runs the script instead of a duplicate grep.
