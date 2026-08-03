---
# pkm-4ler
title: Expose block created/last-changed timestamps in the UI
status: in-progress
type: feature
priority: normal
created_at: 2026-08-01T18:38:10Z
updated_at: 2026-08-03T18:46:16Z
blocked_by:
    - pkm-r7k8
---

DRAFT — UI shape undecided; backend semantics (pkm-r7k8) must land first so the signal is trustworthy.

The data already reaches the client: blocks.created_at/updated_at sync to the replica and are in API responses today, so this is purely a frontend surface question once pkm-r7k8 fixes the collapse-toggle pollution.

## Candidate directions (none chosen)

- Hover tooltip on the block bullet showing created/last-changed dates (zero layout cost)
- Block context-menu "info" entry with both dates
- Visual staleness cue — e.g. subtle dimming or a badge on blocks untouched for N years, maybe per-page opt-in for fast-moving topic pages
- Search/filter by recency ("blocks edited this year"), or sort backlinks by last-changed
- Show last-changed on search results / backlink entries

## Open questions

- Which surface(s) actually get used — Arthur to decide after living with the corrected data
- created_at vs updated_at: show one, both, or relative ("3 years ago")?
- Precision: after pkm-r7k8's backfill, ~6% of created_at values are page-level approximations — worth signalling in the UI or ignore?


## Implementation checklist (plan 2026-08-03-pkm-4ler-block-timestamps.md)

- [ ] Task 1: outline/blockStamps.ts core + tests
- [ ] Task 2: reducer stamps updated_at from an nowMs supplied by the shell
- [ ] Task 3: "Show timestamps" preference (core + hook + context + TopBar item)
- [ ] Task 4: the margin cell (EditableBlockTree/EditablePage/PageView)
- [ ] Task 5: tokens, .block-stamp styles, phone hide
- [ ] Task 6: Playwright pass
- [ ] Task 7: architecture docs + full gates
