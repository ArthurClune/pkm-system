---
# pkm-7a8u
title: 'Ops model: stop predicting which copy wins in a merged rewrite step'
status: scrapped
type: task
priority: normal
created_at: 2026-11-12T15:48:52Z
updated_at: 2026-11-12T16:11:49Z
---

`server/tests/props/model.py` `Model._record` keeps the one marker pkm-k2lf left (`code: replay_core._rewrite_steps`): when two recorded rewrites share a hash pair and hold different copies of one uid, the older row's copy wins. That order falls out of the dict merge in `_rewrite_steps` / `RewriteHistory._add` (`{**step.inlines, **older.inlines}`); no test or docstring chose it.

Ruling (Arthur, 2026-11-12): an accident, so the model stops asserting it rather than gaining a contract row. Options from the pkm-k2lf triage: `_record` keeps both copies for a uid whose copies differ and the state machine skips comparing a block whose replay inlined such a uid (labelled as an event), or the strategies avoid the shape (loses reach; less good).

When the marker goes, drop the model.py header sentence "Where the contracts are silent the rule follows the code, and says so" if nothing else needs it.

- [ ] Model stops predicting the winner; marker removed
- [ ] uv run pytest -q; proptest/check.sh server

## Reasons for Scrapping

The shape it guards (two rewrites sharing a hash pair with different inlined copies of one uid) looks unreachable in practice: an inline record puts the copy into the block's text, so different copies give different after hashes. Removing the marker would add model machinery (both copies kept, the comparison skipped) for a case that may never occur; the only gain was dropping the last "follows the code" marker. Scrapped by Arthur, 2026-11-12.
