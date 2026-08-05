---
# pkm-3f83
title: 'Full review of docs/architecture: emphasis, flow, plain language; fold lessons into architecture-docs skill'
status: completed
type: task
priority: normal
created_at: 2026-08-05T08:17:06Z
updated_at: 2026-08-05T08:25:55Z
---

Arthur asked for a full review of docs/architecture with the most capable model. Review questions: (1) within each section, is the space spent proportional to the topic's importance? (2) does each doc flow top-to-bottom from biggest picture to detail? (3) can the language be simpler while keeping technical rigour (Hemingway not Joyce)? Sub-task: update .claude/skills/architecture-docs based on what the review finds.

- [x] Read all six docs and review emphasis proportionality, flow, and language
- [x] Run check-docs.mjs for sentence-length evidence
- [x] Write up per-doc findings for Arthur (delivered in-session; ranked fix list preserved in pkm-89as)
- [x] Update the architecture-docs skill with generalized lessons (via writing-skills)
- [x] Commit skill update + bean on a branch, merge --no-ff (done in the same commit series as this update)

## Summary of Changes

Reviewed all six docs. Sentence-level health is good (checker: 0-3 sentences over 40 words per doc); the real findings are structural. Cross-doc diagnosis: section depth tracks writer effort (debugging pain, recency of shipping) rather than reader importance, and new material was appended where/when it shipped rather than inserted where its owner-section is. Worst cases: backend.md's Importer (124 lines, largest section in the directory, run-once tool) vs the write path (71); frontend.md styling+focus (219 lines) vs the editor (175), with 35 bold-lead paragraphs; cli-and-mcp.md's orientation section (MCP tool surface) last at 9 lines behind a 65-line grab-bag. sync-and-offline.md and overview.md are healthy.

Skill updated (.claude/skills/architecture-docs/SKILL.md): new "Weight sections by the reader's risk, not the writer's effort" section (length-is-a-claim, descent ordering, normal-work vs only-when-broken test, in-doc ownership); "State the invariant, not the proof" added to plain sentences; two Common-mistakes rows (sizing by effort; appending where the ship happened); definition-list labels exempted from the emphasis rule after a tester misfire. GREEN-verified: two sonnet subagents reviewing backend.md and cli-and-mcp.md with the updated skill independently ranked the planted failures top-of-list, quoting the new wording. Baseline (RED) is the docs themselves: several clarity passes under the old skill left the disproportion standing.

Ranked doc fixes are in draft bean pkm-89as, deliberately left as draft for Arthur to prioritize.
