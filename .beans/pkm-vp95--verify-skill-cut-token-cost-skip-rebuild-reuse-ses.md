---
# pkm-vp95
title: 'verify skill: cut token cost (skip rebuild, reuse session, DOM over screenshots)'
status: completed
type: task
priority: normal
created_at: 2026-07-12T07:10:49Z
updated_at: 2026-07-12T07:13:46Z
---

Update .claude/skills/verify/SKILL.md so /verify runs cheaper: skip pnpm build for server-only changes, reuse one scratch server + browser session across checks in a batch, prefer targeted DOM reads over screenshots. Follow writing-skills TDD: baseline subagent test, edit, re-test.

## Checklist

- [x] RED: baseline subagent scenarios (server-only change; batch reuse) — document wasteful behavior
- [x] GREEN: edit SKILL.md with conditional recipe (skip rebuild, reuse server/session, DOM reads over screenshots)
- [x] Re-test same scenarios with updated skill — verify compliance
- [x] Commit + push (bean file included)

## Summary of Changes

Updated `.claude/skills/verify/SKILL.md` (RED-GREEN per writing-skills):

- Step 1 (build) is now conditional on the diff touching `web/` (observable predicate: `git diff --name-only main | grep '^web/'`), with an explicit counter to the "safer to rebuild" rationalization the baseline agent used verbatim.
- New "Batch sessions: reuse, don't tear down" section: setup/run once per session, reload-and-drive per check, scratch DB content treated as an asset, teardown once at end of batch.
- New "Reading results" section: DOM reads (snapshot/get text/eval) for text assertions; screenshot only for visual assertions, one at final verified state.

Baseline subagent tests (no guidance): rebuilt SPA on a server-only change, planned per-check teardown, 3 screenshots for text assertions. Retests with updated skill: build skipped with correct reasoning, environment reused, 1 justified screenshot for a restyle. Lighter than full 5-rep micro-testing — project reference recipe, both scenarios flipped cleanly.
