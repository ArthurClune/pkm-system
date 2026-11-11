---
# pkm-3m1g
title: 'Docs structure: write-path.md, slimmer AGENTS.md, merged troubleshooting rows, regrowth guard'
status: completed
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T10:38:12Z
parent: pkm-4gda
blocked_by:
    - pkm-t57n
    - pkm-wqnv
    - pkm-7rxj
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W18. Child of the 2026-11-09 maintainability review epic.

## Summary of Changes

- backend.md's write path moved to write-path.md; AGENTS.md slimmed, with deploy and spec material on their own pages; troubleshooting rows merged by symptom; code comments cite the architecture docs, not the frozen spec; check-docs.mjs measures against the merge base and a recorded re-check commit, and checks same-file and inbound links across the tree.
- 2026-11-11 re-check: seven reviewers, wrong claims corrected, agent-wide rules moved from memory into AGENTS.md and frontend.md, two adversarial reviews applied. A second, paragraph-by-paragraph trim of the seven largest architecture docs followed, with a holder named for every deleted rule sentence and a second pair of adversarial reviews (one lost rule restored, six over-claims corrected, pointers repointed).
- Words across AGENTS.md, README.md, deploy/README.md, docs/*.md (the dated security review excepted) and docs/architecture: 78,344 before the re-check; see the merge commit for the figure after.
- Left: troubleshooting.md's Cause cells were not rewritten (Arthur declined); sync-recovery.md § runRecovery is untouched for the recovery-lease work; the STALE_BUNDLE_CRUMB paragraph in backend.md waits on Arthur.
