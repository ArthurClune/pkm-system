---
# pkm-vene
title: Over-limit stale-edit landing can re-create a deleted or renamed-away page
status: completed
type: bug
priority: low
created_at: 2026-10-25T12:48:37Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

Found while planning the server clean-ups (2026-10-25, R1). When a stale offline edit is too long to replay, the server lands the client's text as a daily-note conflict entry exactly as sent; its old links can re-create a page that was deleted or renamed away meanwhile. Reproduced on a scratch server. Fix in security/batch-server Task 8 (steps 4–8).

- [x] Red test from the repro
- [x] Landing never re-creates a deleted/renamed-away page (unlink or rewrite stale titles in the landed note, as the replay would)
- [x] troubleshooting.md row

## Summary of Changes

- Behaviour: an over-limit stale-edit landing now makes every title in the replay chain's `unlinked` and `retitles` keys plain (`over_limit_landing_text`, matched through the canonical form), so it cannot re-create a deleted or renamed-away page; `((uid))` refs stay. `_replay` walks the chain past the step that went over the cap so every step's gone title is named. Reproduced from the bean's scratch repro (delete case: D1 stayed 404, entry `RpDel ((D1)) ((D1))`; rename case; chained case).
- Commits: e3f93ba6 (fix), 04596723 and c8016614 (padded spelling of a renamed-away title, e.g. `[[ Old ]]` under plain-space titles, matched on replay). Troubleshooting rows (re-created page after an over-limit landing; padded spelling).
- Rulings: orchestrator, review I2: pass title_reader whenever the block has any rewrite row, so padded spellings are matched (R1's property is the bean's own claim; cost: one flag read per replayed edit, which Arthur accepted as the perf regression ops/edit-rename-replay 25 -> 26 statements, 2026-10-26, to be re-recorded with --bootstrap backend before merge). Two existing tests that pinned the bug now expect the plain title.
- Follow-ups: pkm-7981 (ops property does not reach the over-limit landings).
