---
# pkm-dhsp
title: 'Import: title migration blocks an export whose only refusal is a title '']]Aaa'' beside ''#Machine Learning::'''
status: completed
type: bug
priority: normal
created_at: 2026-10-24T17:42:57Z
updated_at: 2026-10-25T09:31:02Z
---

Found by test_no_500_stored_props.py::test_every_imported_row_is_served on an unseeded run (2026-10-24, during pkm-8bga's final gate). Reproduced at f91e00cd, before that branch, so pre-existing. Shrunk example: page ']]Aaa' (a refused title, which sanitize_export_titles should skip) with three child blocks, uids 000000 / 0000000 / 00000000, texts '', '', '#Machine Learning::', all order 0, heading False; migrate=True, legacy_heading_zero=False. _import returns False with event 'import refused: title migration blocked' (BlockedTitleMigration from audit/apply_title_migration), so the property's 'a refused title never stops an import' assertion fails. Decide: product bug (the migration should not block here) or wrong property. Fix with the example as a pytest unit test in server/tests/, never in props. Also: equal order_idx on siblings may be part of the trigger.

## Summary of Changes

Product bug, and the property was too weak.
- rename.title_ref_spans returned overlapping rewrites for text like '#Machine Learning::' (the attribute and the tag over the same characters); splicing both produced '#MachineLearning::', a forbidden title that blocked the import's title migration. Now, once a leading attribute is rewritten, tags inside its name are not rewritten separately (like an outer [[link]] winning over nested ones). Old vs new on random text: no difference for user renames and merges.
- A second path: unlinking a refused ref removed the brackets that separated its text from its neighbours, forming new refs ('[[#]]a b:: v' became attribute '#a b'). The export sanitiser now renames before unlinking and a final pass removes any ref the source block didn't name (a new leading attribute is backticked, other new refs become plain text).
- The property now asserts the migration never blocks after sanitising and draws both shapes; the shrunk examples are pytest unit/importer tests outside props/.
- Docs: backend.md § Ref grammar sentence, troubleshooting row.
