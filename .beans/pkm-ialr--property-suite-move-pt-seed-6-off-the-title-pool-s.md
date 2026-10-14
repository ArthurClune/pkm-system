---
# pkm-ialr
title: 'Property suite: move pt_seed_6 off the title pool so DeletePage can delete every page'
status: todo
type: task
priority: low
created_at: 2026-10-14T10:51:43Z
updated_at: 2026-10-14T10:51:43Z
---

Found in the pkm-wvac review. The sync property suite's DeletePage command never deletes the page that holds pt_seed_6 (outcome "spared"), because BadBatch depends on that block staying alive (its 400 comes from uid_taken). That page is the busiest one (most offline edits and creates land on it), so about a quarter of delete draws are wasted and the race is drawn in only ~5% of examples.

Cleaner: seed pt_seed_6 on its own page outside PAGE_TITLES (e.g. "Fixture") in build_template, make BadBatch independent of the title pool, and drop the "spared" outcome. Check the seed/replica fixtures and any fixed scenario that counts Proptest's blocks.

## Todo

- [ ] Move pt_seed_6 to a non-pool page in the harness template
- [ ] Drop DeletePage's spared outcome
- [ ] Re-run proptest/check.sh web --file sync and compare the stale-race tally
