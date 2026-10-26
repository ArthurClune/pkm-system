---
# pkm-iw03
title: Stale-unlink defuse can store two characters past the text cap
status: completed
type: bug
priority: low
created_at: 2026-10-25T03:18:21Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf final re-review (2026-10-25). Outside the stale-edit replay, the stale-unlink path adds two backticks to defuse a leading attribute naming a page deleted while the client was offline; an at-cap (1,000,000 code point) text then stores at 1,000,002. Judge the defused text and land the conflict entry like the replay, or defuse without growing.

- [x] Red test at the cap
- [x] Fix (resolved by ruling: Arthur 2026-10-25 chose option A, allow the two backticks and document the bound, so there is no code fix)
- [x] troubleshooting.md row (resolved, none needed: no behaviour changed, so no row; the bound is stated in backend.md § Planning and § Stale batches)

## Summary of Changes

- Behaviour: none changed. Arthur 2026-10-25, option A: the stale-unlink defuse may store two characters past the cap (every spelling that keeps the name and stops it indexing needs the two backticks; refusing would discard the offline batch). A pin test, `test_a_stale_defuse_at_the_cap_stores_at_most_two_more`, passes today and holds the bound at MAX_BLOCK_TEXT_CHARS + 2 with the page staying deleted. The first checklist item was therefore a pin, not a red test.
- Commit: 5dff2ae8 (docs and pin test); backend.md states the bound in the Text limits bullet and the Stale batches row.
- Ruling: Arthur's option A. Follow-ups: none.
