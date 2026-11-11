---
# pkm-bw6z
title: Store rename, merge and delete reindexing read the plain-space flag once per link
status: scrapped
type: task
priority: normal
created_at: 2026-11-11T02:11:40Z
updated_at: 2026-11-11T13:24:11Z
parent: pkm-4gda
---

The ops path now reads the plain-space flag once per batch (title_reader passed down from apply_batch). The store paths that reindex refs on page rename, merge and delete still call get_or_create_page with canonical=None, so each resolved link reads the flag again. Pass one reader per operation, as apply_batch does, and pin the read count in a test.


## Reasons for Scrapping

A consistency optimisation with no bug behind it: one small SQLite read per link, on page rename, merge and delete, which are rare. Not worth a branch. (Arthur, 2026-11-11.)
