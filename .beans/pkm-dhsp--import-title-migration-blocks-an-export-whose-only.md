---
# pkm-dhsp
title: 'Import: title migration blocks an export whose only refusal is a title '']]Aaa'' beside ''#Machine Learning::'''
status: todo
type: bug
created_at: 2026-10-24T17:42:57Z
updated_at: 2026-10-24T17:42:57Z
---

Found by test_no_500_stored_props.py::test_every_imported_row_is_served on an unseeded run (2026-10-24, during pkm-8bga's final gate). Reproduced at f91e00cd, before that branch, so pre-existing. Shrunk example: page ']]Aaa' (a refused title, which sanitize_export_titles should skip) with three child blocks, uids 000000 / 0000000 / 00000000, texts '', '', '#Machine Learning::', all order 0, heading False; migrate=True, legacy_heading_zero=False. _import returns False with event 'import refused: title migration blocked' (BlockedTitleMigration from audit/apply_title_migration), so the property's 'a refused title never stops an import' assertion fails. Decide: product bug (the migration should not block here) or wrong property. Fix with the example as a pytest unit test in server/tests/, never in props. Also: equal order_idx on siblings may be part of the trigger.
