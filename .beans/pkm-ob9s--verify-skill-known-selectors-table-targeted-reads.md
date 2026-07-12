---
# pkm-ob9s
title: 'verify skill: known-selectors table + targeted reads over full snapshots'
status: completed
type: task
priority: normal
created_at: 2026-07-12T07:40:59Z
updated_at: 2026-07-12T07:46:37Z
---

Follow-up to pkm-vp95. Add a table of real, verified selectors (login, journal block, search dialog, sidebar) pulled from the running app, and a rule preferring get text / is visible / find / scoped snapshot -s over full-page snapshot dumps. RED evidence: even with the updated skill, retest agents planned unscoped 'snapshot' calls for text assertions ('snapshot to confirm the search dialog opened').

## Summary of Changes

Updated `.claude/skills/verify/SKILL.md`:

- New "Known selectors" table: 12 selectors (login, shell, journal, search) extracted from the live app by a subagent, each verified live (`is visible` / `querySelector`) AND grep-confirmed as literal class names in `web/src` (no data-testids exist; nothing hashed/generated). Dated 2026-07-12, with a maintenance rule: if a selector fails, re-derive via scoped snapshot and update the table in the same commit.
- Recorded behavioral facts: Cmd-U is a focus toggle on the always-present top-bar input (no search modal); `li.search-result` may be the synthetic Create-page row; highlighting is a `<mark>` in `span.result-snippet`; blur a block editor by focusing another input.
- "Reading results" reworked: drive/assert with known selectors (`get text`, `is visible`, `eval`); `snapshot` only for UI the table doesn't cover, and then scoped (`-s`) or `-i -c`; bare full-page snapshot is a last resort.

RED: even after pkm-vp95, retest agents planned unscoped `snapshot` calls for text assertions. GREEN retest (search restyle scenario): zero snapshots, all known selectors, targeted eval reads incl. getComputedStyle for the style assertion, one scoped screenshot at final state, batch reuse respected.
