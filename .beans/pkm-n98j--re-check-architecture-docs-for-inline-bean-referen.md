---
# pkm-n98j
title: Re-check architecture docs for inline bean references; add slash command for the check
status: completed
type: task
priority: normal
created_at: 2026-08-12T20:49:36Z
updated_at: 2026-08-12T20:52:25Z
---

Inline pkm-XXXX provenance tags have crept back into docs/architecture prose since the 05/08 docs-rebalance-emphasis pass. Re-check all docs against the architecture-docs skill principles (bean ids live only in the symptom-table Ref column), fix regressions, then add a project-level slash command that runs this re-check on demand.

## Summary of Changes

- Stripped six inline bean references from docs/architecture prose (backend.md ×2, frontend.md ×2, styling.md, sync-and-offline.md); bean ids now appear only in symptom-table Ref columns. check-docs.mjs passes on all four files; no identifiers dropped, no new 40+ word sentences.
- Added `.claude/skills/check-arch-docs/SKILL.md` — the /check-arch-docs slash command sequencing the audit: mechanical grep (tested: flags all six pre-fix violations and a seeded fake, zero false positives on the clean tree), judgment review of the diff since the last re-check, checker run, commit conventions.
- Legitimate pkm- matches documented as exclusions: spec filenames, pkm-specific, pkm-replica.
